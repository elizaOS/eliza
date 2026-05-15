import type { Tool } from "@modelcontextprotocol/sdk/types.js";

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
  default?: unknown;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
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

function buildDescription(name: string, prop: JsonSchemaProperty): string {
  // Start with the MCP server's description if available.
  // Avoid redundant "Parameter: X" — the parameter name is already shown by the formatter.
  const parts: string[] = [];
  if (prop.description) {
    parts.push(prop.description);
  }

  if (prop.enum?.length)
    parts.push(`Allowed: ${prop.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  if (prop.format) parts.push(`Format: ${prop.format}`);
  if (prop.minimum !== undefined || prop.maximum !== undefined) {
    parts.push(
      `Range: ${[prop.minimum !== undefined ? `min: ${prop.minimum}` : "", prop.maximum !== undefined ? `max: ${prop.maximum}` : ""].filter(Boolean).join(", ")}`,
    );
  }
  if (prop.minLength !== undefined || prop.maxLength !== undefined) {
    parts.push(
      `Length: ${[prop.minLength !== undefined ? `min: ${prop.minLength}` : "", prop.maxLength !== undefined ? `max: ${prop.maxLength}` : ""].filter(Boolean).join(", ")}`,
    );
  }
  if (prop.pattern) parts.push(`Pattern: ${prop.pattern}`);
  if (prop.default !== undefined) parts.push(`Default: ${JSON.stringify(prop.default)}`);
  if (prop.type === "array" && prop.items) parts.push(`Array of ${prop.items.type || "any"}`);
  if (prop.type === "object" && prop.properties) {
    const keys = Object.keys(prop.properties);
    parts.push(`Object with keys: ${keys.join(", ")}`);
  }

  // If no description and no constraints, provide a minimal type-based hint
  return parts.length > 0 ? parts.join(". ") : `(${mapJsonSchemaType(prop.type)})`;
}

export function convertJsonSchemaToActionParams(
  schema?: Tool["inputSchema"],
): ActionParameter[] | undefined {
  const properties = schema?.properties as Record<string, JsonSchemaProperty> | undefined;
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
  schema?: Tool["inputSchema"],
): string[] {
  if (!schema) return [];

  const errors: string[] = [];
  const properties = schema.properties as Record<string, JsonSchemaProperty> | undefined;
  const required = new Set<string>((schema.required as string[]) || []);

  for (const field of required) {
    if (params[field] === undefined || params[field] === null) {
      errors.push(`Missing required parameter: ${field}`);
    }
  }

  if (properties) {
    for (const [name, value] of Object.entries(params)) {
      const prop = properties[name];
      if (!prop) continue;

      const expected = mapJsonSchemaType(prop.type);
      const actual = getValueType(value);

      if (actual !== expected && value !== null && value !== undefined) {
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
