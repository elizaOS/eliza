/**
 * Retrieves the JSON schema representation of a Zod schema.
 * Uses dynamic import to avoid hard dep on zod-to-json-schema.
 * @param schema - The Zod schema to convert to JSON schema.
 * @returns The JSON schema representation, or undefined if conversion unavailable.
 */
export async function getZodJsonSchema(schema: {
	_def?: unknown;
}): Promise<Record<string, unknown> | undefined> {
	try {
		const mod = await import("zod-to-json-schema");
		const convert = mod.default ?? mod;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- zod-to-json-schema accepts both zod v3 and v4 schemas
		const result = (
			convert as (
				s: unknown,
				n: string,
			) => Record<string, Record<string, unknown>>
		)(schema, "schema");
		return result.definitions?.schema as Record<string, unknown> | undefined;
	} catch {
		return undefined;
	}
}
