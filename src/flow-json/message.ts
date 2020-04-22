import {
  filePathToPseudoNamespace, snakeToCamel,
  // uppercaseFirst, oneOfName,
  isProto2,
  normaliseFieldObjectName, withinNamespaceFromExportEntryFlowJson
} from "../util";
import {ExportMap} from "../ExportMap";
import {
  FieldDescriptorProto, FileDescriptorProto, DescriptorProto,
  FieldOptions
} from "google-protobuf/google/protobuf/descriptor_pb";
import {MESSAGE_TYPE, BYTES_TYPE, ENUM_TYPE, getFieldType, getTypeName} from "./FieldTypes";
import {Printer} from "../Printer";
import {printEnum} from "./enum";
import {printOneOfDecl} from "./oneof";
import {printExtension} from "./extensions";
import JSType = FieldOptions.JSType;

function hasFieldPresence(field: FieldDescriptorProto, fileDescriptor: FileDescriptorProto): boolean {
  if (field.getLabel() === FieldDescriptorProto.Label.LABEL_REPEATED) {
    return false;
  }

  if (field.hasOneofIndex()) {
    return true;
  }

  if (field.getType() === MESSAGE_TYPE) {
    return true;
  }

  if (isProto2(fileDescriptor)) {
    return true;
  }

  return false;
}

export function printMessage(fileName: string, exportMap: ExportMap, messageDescriptor: DescriptorProto, indentLevel: number, fileDescriptor: FileDescriptorProto, prefixName?: string) {

  const messageName = prefixName && prefixName !== "" ? `${prefixName}_${messageDescriptor.getName()}` : messageDescriptor.getName();
  const messageOptions = messageDescriptor.getOptions();
  if (messageOptions !== undefined && messageOptions.getMapEntry()) {
    // this message type is the entry tuple for a map - don't output it
    return "";
  }

  const toObjectType = new Printer(indentLevel);
  toObjectType.printLn(`export type ${messageName} = {`);

  const printer = new Printer(indentLevel);
  const oneOfGroups: Array<Array<FieldDescriptorProto>> = [];

  messageDescriptor.getFieldList().forEach(field => {
    if (field.hasOneofIndex()) {
      const oneOfIndex = field.getOneofIndex();
      let existing = oneOfGroups[oneOfIndex];
      if (existing === undefined) {
        existing = [];
        oneOfGroups[oneOfIndex] = existing;
      }
      existing.push(field);
    }
    const snakeCaseName = field.getName().toLowerCase();
    const camelCaseName = snakeToCamel(snakeCaseName);
    // const withUppercase = uppercaseFirst(camelCaseName);
    const type = field.getType();

    let exportType;
    const fullTypeName = field.getTypeName().slice(1);
    if (type === MESSAGE_TYPE) {
      const fieldMessageType = exportMap.getMessage(fullTypeName);
      if (fieldMessageType === undefined) {
        throw new Error("No message export for: " + fullTypeName);
      }
      if (fieldMessageType.messageOptions !== undefined && fieldMessageType.messageOptions.getMapEntry()) {
        // This field is a map
        const keyTuple = fieldMessageType.mapFieldOptions!.key;
        const keyType = keyTuple[0];
        const keyTypeName = getFieldType(keyType, keyTuple[1], fileName, exportMap);
        const valueTuple = fieldMessageType.mapFieldOptions!.value;
        const valueType = valueTuple[0];
        let valueTypeName = getFieldType(valueType, valueTuple[1], fileName, exportMap);
        if (valueType === BYTES_TYPE) {
          valueTypeName = "Uint8Array | string";
        }
        if (valueType === ENUM_TYPE) {
          valueTypeName = `$Values<typeof ${valueTypeName}>`;
        }
        toObjectType.printIndentedLn(`${camelCaseName}: Array<[${keyTypeName}, ${valueTypeName}]>,`);
        return;
      }
      const withinNamespace = withinNamespaceFromExportEntryFlowJson(fullTypeName, fieldMessageType);
      if (fieldMessageType.fileName === fileName) {
        exportType = `${withinNamespace}`;
      } else {
        exportType = filePathToPseudoNamespace(fieldMessageType.fileName) + "." + `${withinNamespace}`;
      }
    } else if (type === ENUM_TYPE) {
      const fieldEnumType = exportMap.getEnum(fullTypeName);
      if (fieldEnumType === undefined) {
        throw new Error("No enum export for: " + fullTypeName);
      }
      const withinNamespace = withinNamespaceFromExportEntryFlowJson(fullTypeName, fieldEnumType);
      if (fieldEnumType.fileName === fileName) {
        exportType = `$Values<typeof ${withinNamespace}>`;
      } else {
        exportType = `$Values<typeof ${filePathToPseudoNamespace(fieldEnumType.fileName) + "." + withinNamespace}>`;
      }
    } else {
      if (field.getOptions() && field.getOptions().hasJstype()) {
        switch (field.getOptions().getJstype()) {
          case JSType.JS_NUMBER:
            exportType = "number";
            break;
          case JSType.JS_STRING:
            exportType = "string";
            break;
          default:
            exportType = getTypeName(type);
        }
      } else {
        exportType = getTypeName(type);
      }
    }

    let hasClearMethod = false;
    function printClearIfNotPresent() {
      if (!hasClearMethod) {
        hasClearMethod = true;
      }
    }

    if (hasFieldPresence(field, fileDescriptor)) {
      printClearIfNotPresent();
    }

    // function printRepeatedAddMethod(valueType: string) {
    //   const optionalValue = field.getType() === MESSAGE_TYPE;
    // }

    if (field.getLabel() === FieldDescriptorProto.Label.LABEL_REPEATED) {// is repeated
      printClearIfNotPresent();
      if (type === BYTES_TYPE) {
        toObjectType.printIndentedLn(`${camelCaseName}: Array<Uint8Array | string>,`);
        // printRepeatedAddMethod("Uint8Array | string");
      } else {
        toObjectType.printIndentedLn(`${camelCaseName}: Array<${exportType}>,`);
        // printRepeatedAddMethod(exportType);
      }
    } else {
      if (type === BYTES_TYPE) {
        toObjectType.printIndentedLn(`${camelCaseName}: Uint8Array | string,`);
      } else {
        let fieldObjectType = exportType;
        let canBeUndefined = false;
        if (type === MESSAGE_TYPE) {
          // fieldObjectType += `$${objectTypeName}`;
          if (!isProto2(fileDescriptor) || (field.getLabel() === FieldDescriptorProto.Label.LABEL_OPTIONAL)) {
            canBeUndefined = true;
          }
        } else {
          if (isProto2(fileDescriptor)) {
            canBeUndefined = true;
          }
        }
        const fieldObjectName = normaliseFieldObjectName(camelCaseName);
        toObjectType.printIndentedLn(`${fieldObjectName}${canBeUndefined ? "?" : ""}: ${fieldObjectType},`);
      }
    }
  });

  toObjectType.printLn(`}`);

  // messageDescriptor.getOneofDeclList().forEach(oneOfDecl => {

  // });

  printer.print(toObjectType.getOutput());

  messageDescriptor.getNestedTypeList().forEach(nested => {
    const msgOutput = printMessage(fileName, exportMap, nested, indentLevel, fileDescriptor, messageName);
    if (msgOutput !== "") {
      // If the message class is a Map entry then it isn't output, so don't print the namespace block
      printer.print(msgOutput);
    }
  });
  messageDescriptor.getEnumTypeList().forEach(enumType => {
    printer.print(`${printEnum(enumType, indentLevel, messageName)}`);
  });
  messageDescriptor.getOneofDeclList().forEach((oneOfDecl, index) => {
    printer.print(`${printOneOfDecl(oneOfDecl, oneOfGroups[index] || [], indentLevel, messageName)}`);
  });
  messageDescriptor.getExtensionList().forEach(extension => {
    printer.print(printExtension(fileName, exportMap, extension, indentLevel, messageName));
  });


  return printer.getOutput();
}