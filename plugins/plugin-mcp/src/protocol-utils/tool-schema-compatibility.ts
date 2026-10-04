import type { JSONSchema7 } from "json-schema";
/**
 * Walks untrusted MCP tool schemas through a host-supplied provider policy,
 * preserving stripped constraints in model-visible descriptions.
 */

import { assertMcpJsonSchemaBudget } from "./schema-budget.js";

export type McpJsonSchema = Readonly<Record<string, unknown>>;

export interface McpSchemaCompatibilityPolicy {
  readonly applies: boolean;
  unsupportedFor(type: string | undefined): readonly string[];
  describe(original: string | undefined, constraints: Readonly<Record<string, unknown>>): string;
}

const CONSTRAINT_KEYS = [
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "enum",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "additionalProperties",
] as const;

function asSchema(value: unknown): McpJsonSchema | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as McpJsonSchema)
    : null;
}

/** JSON Schema type arrays are unordered sets; normalize only for policy evaluation. */
function policyTypes(value: unknown): readonly (string | undefined)[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [undefined];
  const types = Array.from(
    new Set(value.filter((member): member is string => typeof member === "string"))
  ).sort();
  return types.length > 0 ? types : [undefined];
}

function rewriteSchema(
  schema: McpJsonSchema,
  policy: McpSchemaCompatibilityPolicy
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...schema };
  const unsupported = Array.from(
    new Set(policyTypes(schema.type).flatMap((type) => policy.unsupportedFor(type)))
  );
  const constraints: Record<string, unknown> = {};
  for (const key of CONSTRAINT_KEYS) {
    if (key === "additionalProperties" && !unsupported.includes(key)) continue;
    if (schema[key] !== undefined) constraints[key] = schema[key];
  }
  for (const key of unsupported) {
    delete output[key];
  }

  const items = asSchema(schema.items);
  if (items) output.items = rewriteSchema(items, policy);

  const properties = asSchema(schema.properties);
  if (properties) {
    output.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => {
        const child = asSchema(value);
        return [key, child ? rewriteSchema(child, policy) : value];
      })
    );
  }

  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const variants = schema[key];
    if (Array.isArray(variants)) {
      output[key] = variants.map((value) => {
        const child = asSchema(value);
        return child ? rewriteSchema(child, policy) : value;
      });
    }
  }

  if (Object.keys(constraints).length > 0) {
    output.description = policy.describe(
      typeof schema.description === "string" ? schema.description : undefined,
      constraints
    );
  }
  return output;
}

export function transformMcpToolSchema<TSchema extends McpJsonSchema>(
  schema: TSchema,
  policy: McpSchemaCompatibilityPolicy
): TSchema {
  assertMcpJsonSchemaBudget(schema);
  if (!policy.applies) return schema;
  const rewritten = rewriteSchema(schema, policy);
  assertMcpJsonSchemaBudget(rewritten);
  return rewritten as TSchema;
}

/** Shared schema transformation; hosts retain model selection and description policy. */
export abstract class McpSchemaCompatibility<
  TModelInfo,
  TConstraints extends object = Record<string, unknown>,
> {
  protected readonly modelInfo: TModelInfo;
  constructor(modelInfo: TModelInfo) {
    this.modelInfo = modelInfo;
  }
  abstract shouldApply(): boolean;
  transformToolSchema<TSchema extends JSONSchema7>(toolSchema: TSchema): TSchema {
    return transformMcpToolSchema(toolSchema as Record<string, unknown>, {
      applies: this.shouldApply(),
      unsupportedFor: (type) => this.unsupportedFor(type),
      describe: (original, constraints) =>
        this.mergeDescription(original, { ...constraints } as TConstraints),
    }) as TSchema;
  }
  private unsupportedFor(type: string | undefined): readonly string[] {
    switch (type) {
      case "string":
        return this.getUnsupportedStringProperties();
      case "number":
      case "integer":
        return this.getUnsupportedNumberProperties();
      case "array":
        return this.getUnsupportedArrayProperties();
      case "object":
        return this.getUnsupportedObjectProperties();
      default:
        return [];
    }
  }
  protected mergeDescription(original: string | undefined, constraints: TConstraints): string {
    const serialized = this.stringifyConstraints(constraints);
    return original ? `${original}\n${serialized}` : serialized;
  }
  protected stringifyConstraints(constraints: TConstraints): string {
    return JSON.stringify(constraints);
  }
  protected abstract getUnsupportedStringProperties(): readonly string[];
  protected abstract getUnsupportedNumberProperties(): readonly string[];
  protected abstract getUnsupportedArrayProperties(): readonly string[];
  protected abstract getUnsupportedObjectProperties(): readonly string[];
}
