/** Keep inactive array fields required, without advertising operations that the
 * field registry has already marked N/A for this model call. */
import type { JSONSchema } from "../../types/model";

export function withInactiveArrayFields(
	schema: JSONSchema,
	skippedFields: readonly string[],
): JSONSchema {
	let properties = schema.properties;
	for (const name of skippedFields) {
		const field = properties?.[name];
		// Only plain array contracts whose empty value is unambiguously valid.
		// Custom/composed contracts retain their complete schema.
		if (
			field?.type !== "array" ||
			Object.keys(field).some(
				(key) =>
					![
						"type",
						"items",
						"description",
						"minItems",
						"maxItems",
						"uniqueItems",
					].includes(key),
			) ||
			(typeof field.minItems === "number" && field.minItems > 0)
		)
			continue;
		properties = {
			...properties,
			[name]: {
				type: "array",
				items: { type: "string" },
				enum: [[]],
				description: "Inactive this turn; return [].",
			},
		};
	}
	return properties === schema.properties ? schema : { ...schema, properties };
}
