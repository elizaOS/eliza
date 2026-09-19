/** Converts MCP JSON Schemas into runtime action parameters without dropping constraints. */
export interface McpInputSchema {
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** MCP → runtime action parameter row (replaces removed @elizaos/core ActionParameter export). */
export interface ActionParameter {
  name: string;
  description: string;
  required?: boolean;
  schema: {
    type: "string" | "number" | "boolean" | "object" | "array";
    default?: unknown;
    enum?: string[];
    enumValues?: string[];
  };
}

interface JsonSchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  items?: JsonSchemaProperty | JsonSchemaProperty[];
  contains?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaProperty;
  minProperties?: number;
  maxProperties?: number;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  pattern?: string;
  $ref?: string;
  oneOf?: JsonSchemaProperty[];
  anyOf?: JsonSchemaProperty[];
  allOf?: JsonSchemaProperty[];
  nullable?: boolean;
}

function mapJsonSchemaType(
  jsonType: string | string[] | undefined,
): ActionParameter["schema"]["type"] {
  if (Array.isArray(jsonType)) {
    return mapJsonSchemaType(jsonType.find((t) => t !== "null"));
  }
  switch (jsonType) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    default:
      return "object";
  }
}

function formatType(type?: string | string[]): string {
  if (!type) return "";
  if (Array.isArray(type)) {
    return type.join(" | ");
  }
  return type;
}

function isNullable(prop?: JsonSchemaProperty): boolean {
  if (!prop) return false;
  if (prop.nullable === true) return true;
  if (prop.type === "null") return true;
  if (Array.isArray(prop.type) && prop.type.includes("null")) return true;
  if (prop.oneOf?.some((v) => isNullable(v))) return true;
  if (prop.anyOf?.some((v) => isNullable(v))) return true;
  return false;
}

function renderSchemaDetails(prop: JsonSchemaProperty): string {
  const parts: string[] = [];
  if (prop.description) {
    parts.push(prop.description);
  }

  if (prop.enum?.length) {
    parts.push(
      `Allowed: ${prop.enum.map((v) => JSON.stringify(v)).join(", ")}`,
    );
  }
  if (prop.const !== undefined) {
    parts.push(`Const: ${JSON.stringify(prop.const)}`);
  }
  if (prop.format) {
    parts.push(`Format: ${prop.format}`);
  }

  const bounds: string[] = [];
  if (prop.minimum !== undefined) bounds.push(`min: ${prop.minimum}`);
  if (prop.exclusiveMinimum !== undefined)
    bounds.push(`exclusiveMin: ${prop.exclusiveMinimum}`);
  if (prop.maximum !== undefined) bounds.push(`max: ${prop.maximum}`);
  if (prop.exclusiveMaximum !== undefined)
    bounds.push(`exclusiveMax: ${prop.exclusiveMaximum}`);
  if (bounds.length > 0) {
    parts.push(`Range: ${bounds.join(", ")}`);
  }
  if (prop.multipleOf !== undefined) {
    parts.push(`Multiple of: ${prop.multipleOf}`);
  }

  const lengths: string[] = [];
  if (prop.minLength !== undefined) lengths.push(`min: ${prop.minLength}`);
  if (prop.maxLength !== undefined) lengths.push(`max: ${prop.maxLength}`);
  if (lengths.length > 0) {
    parts.push(`Length: ${lengths.join(", ")}`);
  }
  if (prop.pattern) {
    parts.push(`Pattern: ${prop.pattern}`);
  }

  const itemCounts: string[] = [];
  if (prop.minItems !== undefined) itemCounts.push(`min: ${prop.minItems}`);
  if (prop.maxItems !== undefined) itemCounts.push(`max: ${prop.maxItems}`);
  if (itemCounts.length > 0) {
    parts.push(`Item count: ${itemCounts.join(", ")}`);
  }
  if (prop.uniqueItems) {
    parts.push("Unique items: true");
  }
  if (prop.items) {
    if (Array.isArray(prop.items)) {
      const tupleItems = prop.items
        .map((item) => {
          const t = formatType(item.type) || "any";
          const d = renderSchemaDetails(item);
          return d ? `${t} (${d})` : t;
        })
        .join(", ");
      parts.push(`Tuple items: [${tupleItems}]`);
    } else {
      const itemType = formatType(prop.items.type) || "any";
      const itemDetails = renderSchemaDetails(prop.items);
      if (itemDetails) {
        parts.push(`Array of ${itemType} (${itemDetails})`);
      } else {
        parts.push(`Array of ${itemType}`);
      }
    }
  }
  if (prop.contains) {
    const containsDetails = renderSchemaDetails(prop.contains);
    const containsType = formatType(prop.contains.type) || "any";
    parts.push(
      `Contains: ${containsDetails ? `${containsType} (${containsDetails})` : containsType}`,
    );
  }

  const propCounts: string[] = [];
  if (prop.minProperties !== undefined)
    propCounts.push(`min: ${prop.minProperties}`);
  if (prop.maxProperties !== undefined)
    propCounts.push(`max: ${prop.maxProperties}`);
  if (propCounts.length > 0) {
    parts.push(`Property count: ${propCounts.join(", ")}`);
  }
  if (prop.additionalProperties === false) {
    parts.push("Additional properties: false");
  } else if (
    typeof prop.additionalProperties === "object" &&
    prop.additionalProperties !== null
  ) {
    const addlType = formatType(prop.additionalProperties.type) || "any";
    const addlDetails = renderSchemaDetails(prop.additionalProperties);
    parts.push(
      `Additional properties: ${addlDetails ? `${addlType} (${addlDetails})` : addlType}`,
    );
  }
  if (prop.properties && Object.keys(prop.properties).length > 0) {
    const reqSet = new Set(prop.required || []);
    const renderedProps = Object.entries(prop.properties).map(([k, p]) => {
      const isReq = reqSet.has(k);
      const pType = formatType(p.type) || "any";
      const pDetails = renderSchemaDetails(p);
      const reqStr = isReq ? "required" : "optional";
      if (pDetails) {
        return `${k} (${pType}, ${reqStr}): ${pDetails}`;
      }
      return `${k} (${pType}, ${reqStr})`;
    });
    parts.push(`Properties: { ${renderedProps.join("; ")} }`);
  }

  if (prop.$ref) {
    parts.push(`$ref: ${prop.$ref}`);
  }
  if (prop.oneOf?.length) {
    const variants = prop.oneOf.map((v) => {
      const vType = formatType(v.type);
      const vDetails = renderSchemaDetails(v);
      if (vType && vDetails) return `${vType} (${vDetails})`;
      return vDetails || vType || "unknown";
    });
    parts.push(`One of: [${variants.join(" | ")}]`);
  }
  if (prop.anyOf?.length) {
    const variants = prop.anyOf.map((v) => {
      const vType = formatType(v.type);
      const vDetails = renderSchemaDetails(v);
      if (vType && vDetails) return `${vType} (${vDetails})`;
      return vDetails || vType || "unknown";
    });
    parts.push(`Any of: [${variants.join(" | ")}]`);
  }
  if (prop.allOf?.length) {
    const variants = prop.allOf.map((v) => {
      const vType = formatType(v.type);
      const vDetails = renderSchemaDetails(v);
      if (vType && vDetails) return `${vType} (${vDetails})`;
      return vDetails || vType || "unknown";
    });
    parts.push(`All of: [${variants.join(" & ")}]`);
  }
  if (prop.default !== undefined) {
    parts.push(`Default: ${JSON.stringify(prop.default)}`);
  }

  return parts.join(". ");
}

function buildDescription(_name: string, prop: JsonSchemaProperty): string {
  const details = renderSchemaDetails(prop);
  return details.length > 0 ? details : `(${mapJsonSchemaType(prop.type)})`;
}

export function convertJsonSchemaToActionParams(
  schema?: McpInputSchema,
): ActionParameter[] | undefined {
  const properties = schema?.properties as
    | Record<string, JsonSchemaProperty>
    | undefined;
  if (!properties || Object.keys(properties).length === 0) return undefined;

  const required = new Set<string>((schema?.required as string[]) || []);
  const params: ActionParameter[] = [];

  for (const [name, prop] of Object.entries(properties)) {
    params.push({
      name,
      description: buildDescription(name, prop),
      required: required.has(name),
      schema: {
        type: mapJsonSchemaType(prop.type),
        default: prop.default,
        enum: prop.enum?.map((value) => String(value)),
        enumValues: prop.enum?.map((value) => String(value)),
      },
    });
  }

  return params.length > 0 ? params : undefined;
}

export function validateParamsAgainstSchema(
  params: Record<string, unknown>,
  schema?: McpInputSchema,
): string[] {
  if (!schema) return [];

  const errors: string[] = [];
  const properties = schema.properties as
    | Record<string, JsonSchemaProperty>
    | undefined;
  const required = new Set<string>((schema.required as string[]) || []);

  for (const field of required) {
    const val = params[field];
    const prop = properties?.[field];
    if (val === undefined || (val === null && !isNullable(prop))) {
      errors.push(`Missing required parameter: ${field}`);
    }
  }

  if (properties) {
    for (const [name, value] of Object.entries(params)) {
      const prop = properties[name];
      if (!prop) continue;

      if (value === null) {
        continue;
      }
      if (value === undefined) continue;

      const expected = mapJsonSchemaType(prop.type);
      const actual = getValueType(value);

      if (Array.isArray(prop.type)) {
        const allowedTypes = prop.type
          .filter((t) => t !== "null")
          .map((t) => (t === "integer" ? "number" : t));
        if (!allowedTypes.includes(actual)) {
          errors.push(
            `Parameter '${name}' expected ${expected}, got ${actual}`,
          );
        }
      } else if (actual !== expected) {
        errors.push(`Parameter '${name}' expected ${expected}, got ${actual}`);
      }

      if (prop.enum && !prop.enum.includes(value)) {
        errors.push(
          `Parameter '${name}' must be one of: ${prop.enum.map((v) => JSON.stringify(v)).join(", ")}`,
        );
      }
    }
  }

  return errors;
}

function getValueType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "object";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}
