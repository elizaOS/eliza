/** Omit inactive fields from a model call while preserving
 * registered schemas and custom contracts for later turns. */
import type { JSONSchema } from "@elizaos/core";

export function withoutInactiveFields(
  schema: JSONSchema,
  skippedFields: readonly string[],
): JSONSchema {
  let properties = schema.properties;
  for (const name of skippedFields) {
    const field = properties?.[name];
    if (!field) continue;
    properties = { ...properties };
    delete properties[name];
  }
  return properties === schema.properties
    ? schema
    : {
        ...schema,
        properties,
        ...(schema.required
          ? {
              required: schema.required.filter(
                (name) => properties && name in properties,
              ),
            }
          : {}),
      };
}
