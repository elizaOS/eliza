/**
 * Factors repeated response-schema definitions into local references for Cerebras.
 * Only a known schema vocabulary is rewritten; existing references, dialects and
 * custom keywords retain their original representation and resolution rules.
 */
import type { JSONSchema7 } from "ai";

type Schema = JSONSchema7 | boolean;
const scalarKeywords = new Set([
  "type",
  "title",
  "description",
  "default",
  "examples",
  "enum",
  "const",
  "required",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "readOnly",
  "writeOnly",
]);
const singleKeywords = new Set([
  "items",
  "additionalProperties",
  "additionalItems",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
]);
const arrayKeywords = new Set(["anyOf", "oneOf", "allOf"]);
const mapKeywords = new Set(["properties", "patternProperties"]);

function isSchema(value: unknown): value is Schema {
  return (
    typeof value === "boolean" ||
    (value !== null && typeof value === "object" && !Array.isArray(value))
  );
}

/** Returns the original schema when factoring is unsupported or would add bytes. */
export function factorResponseSchema(schema: JSONSchema7): JSONSchema7 {
  const counts = new Map<string, number>();
  let supported = true;
  const visitChildren = (node: JSONSchema7, visit: (child: Schema) => Schema): JSONSchema7 => {
    const entries = Object.entries(node).map(([key, value]) => {
      if (scalarKeywords.has(key)) return [key, value];
      if (singleKeywords.has(key) && isSchema(value)) return [key, visit(value)];
      if (
        (arrayKeywords.has(key) || key === "items") &&
        Array.isArray(value) &&
        value.every(isSchema)
      ) {
        return [key, value.map(visit)];
      }
      if (
        mapKeywords.has(key) &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        const children = Object.entries(value);
        if (children.every(([, child]) => isSchema(child))) {
          return [
            key,
            Object.fromEntries(children.map(([name, child]) => [name, visit(child as Schema)])),
          ];
        }
      }
      supported = false;
      return [key, value];
    });
    return Object.fromEntries(entries) as JSONSchema7;
  };
  const count = (node: Schema): Schema => {
    if (typeof node === "boolean") return node;
    const serialized = JSON.stringify(node);
    // Small definitions cost more to name and reference than to repeat.
    if (serialized.length > 200) counts.set(serialized, (counts.get(serialized) ?? 0) + 1);
    visitChildren(node, count);
    return node;
  };
  count(schema);
  if (!supported) return schema;

  const names = new Map<string, string>();
  const definitions: Record<string, JSONSchema7> = {};
  const project = (node: Schema): Schema => {
    if (typeof node === "boolean") return node;
    const serialized = JSON.stringify(node);
    if ((counts.get(serialized) ?? 0) > 1) {
      let name = names.get(serialized);
      if (name === undefined) {
        name = `d${names.size}`;
        names.set(serialized, name);
        // Keep definitions inline internally: no recursive or chained references.
        definitions[name] = node;
      }
      return { $ref: `#/$defs/${name}` };
    }
    return visitChildren(node, project);
  };
  const result = { ...visitChildren(schema, project), $defs: definitions };
  return names.size > 0 && JSON.stringify(result).length < JSON.stringify(schema).length
    ? result
    : schema;
}
