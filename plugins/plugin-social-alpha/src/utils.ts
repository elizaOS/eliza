import { XMLParser } from "fast-xml-parser";
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

/**
 * Extracts XML content from a given string based on a specified tag.
 *
 * @param {string} output - The input string containing XML content.
 * @param {string} tag - The tag to extract XML content from.
 * @returns {string} The XML content extracted from the input string based on the specified tag. Returns an empty string if the tag is not found.
 */
export function extractXMLFromResponse(output: string, tag: string) {
	const start = output.indexOf(`<${tag}>`);
	const end = output.indexOf(`</${tag}>`) + `</${tag}>`.length;

	if (start === -1 || end === -1) {
		return "";
	}

	return output.slice(start, end);
}

/**
 * Parse the recommendations response XML and extract the individual recommendations as an array.
 *
 * @param {string} xmlResponse The XML response containing the recommendations data
 * @returns {Array<Object>} An array of recommendation objects extracted from the XML response
 */
export function parseRecommendationsResponse(xmlResponse: string) {
	const parser = new XMLParser({
		ignoreAttributes: false,
		isArray: (name: string) => name === "recommendation", // Treat individual recommendations as array elements
	});
	const result = parser.parse(xmlResponse);
	return result.new_recommendations?.recommendation || []; // Access the nested array structure
}

/**
 * Parses the token response XML string and returns an array of token addresses.
 *
 * @param {string} xmlResponse - The XML response string to parse
 * @returns {string[]} - An array of token addresses extracted from the XML response
 */
export function parseTokensResponse(xmlResponse: string) {
	const parser = new XMLParser({
		ignoreAttributes: false,
		isArray: (name: string) => name === "tokenAddress", // Treat individual recommendations as array elements
	});
	const result = parser.parse(xmlResponse);
	return result.tokens.tokenAddress || []; // Access the nested array structure
}

/**
 * Parses the confirmation response received in XML format and extracts the message.
 *
 * @param {string} xmlResponse The XML response containing the confirmation message
 * @returns {string} The confirmation message extracted from the XML response, or an empty string if not found
 */
export function parseConfirmationResponse(xmlResponse: string) {
	const parser = new XMLParser({
		ignoreAttributes: false,
	});
	const result = parser.parse(xmlResponse);
	return result.message || "";
}

/**
 * Parses the XML response and extracts the 'signal' value.
 * @param {string} xmlResponse - The XML response to parse.
 * @returns {string} The extracted 'signal' value from the XML response.
 */
export function parseSignalResponse(xmlResponse: string) {
	const parser = new XMLParser({
		ignoreAttributes: false,
	});
	const result = parser.parse(xmlResponse);
	return result.signal;
}

/**
 * Parses the token response from an XML format and extracts the token value.
 *
 * @param {string} xmlResponse - The XML response containing the token information.
 * @returns {string} The extracted token value.
 */
export function parseTokenResponse(xmlResponse: string) {
	const parser = new XMLParser({
		ignoreAttributes: false,
	});
	const result = parser.parse(xmlResponse);
	return result.token;
}
