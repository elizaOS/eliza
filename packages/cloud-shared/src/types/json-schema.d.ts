declare module "json-schema" {
  export type JSONSchema7TypeName =
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "object"
    | "array"
    | "null";

  export type JSONSchema7Definition = JSONSchema7 | boolean;

  export interface JSONSchema7 {
    $id?: string;
    $schema?: string;
    $ref?: string;
    $comment?: string;
    title?: string;
    description?: string;
    default?: unknown;
    readOnly?: boolean;
    writeOnly?: boolean;
    examples?: unknown[];
    multipleOf?: number;
    maximum?: number;
    exclusiveMaximum?: number;
    minimum?: number;
    exclusiveMinimum?: number;
    maxLength?: number;
    minLength?: number;
    pattern?: string;
    additionalItems?: JSONSchema7Definition;
    items?: JSONSchema7Definition | JSONSchema7Definition[];
    maxItems?: number;
    minItems?: number;
    uniqueItems?: boolean;
    contains?: JSONSchema7Definition;
    maxProperties?: number;
    minProperties?: number;
    required?: string[];
    additionalProperties?: JSONSchema7Definition;
    definitions?: Record<string, JSONSchema7Definition>;
    properties?: Record<string, JSONSchema7Definition>;
    patternProperties?: Record<string, JSONSchema7Definition>;
    dependencies?: Record<string, JSONSchema7Definition | string[]>;
    propertyNames?: JSONSchema7Definition;
    const?: unknown;
    enum?: unknown[];
    type?: JSONSchema7TypeName | JSONSchema7TypeName[];
    format?: string;
    contentMediaType?: string;
    contentEncoding?: string;
    if?: JSONSchema7Definition;
    then?: JSONSchema7Definition;
    else?: JSONSchema7Definition;
    allOf?: JSONSchema7Definition[];
    anyOf?: JSONSchema7Definition[];
    oneOf?: JSONSchema7Definition[];
    not?: JSONSchema7Definition;
  }
}
