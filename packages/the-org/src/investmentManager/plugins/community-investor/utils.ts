import { XMLParser } from 'fast-xml-parser';
import type { ZodType } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

/**
 * Retrieves the JSON schema representation of a Zod schema.
 * @param {ZodType<any>} schema - The Zod schema to convert to JSON schema.
 * @returns {any} The JSON schema representing the Zod schema.
 */
export function getZodJsonSchema(schema: ZodType<any>) {
  return zodToJsonSchema(schema, 'schema').definitions?.schema;
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
    return '';
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
    isArray: (name) => name === 'recommendation', // Treat individual recommendations as array elements
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
    isArray: (name) => name === 'tokenAddress', // Treat individual recommendations as array elements
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
  return result.message || '';
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

export const BuyAmountConfig = {
  MAX_ACCOUNT_PERCENTAGE: 0.05,
  MIN_BUY_LAMPORTS: BigInt(100000000), // 0.1 SOL
  MAX_BUY_LAMPORTS: BigInt(10000000000), // 10 SOL,
  MAX_LIQUIDITY_MULTIPLIER: 1.5,
  MAX_VOLUME_MULTIPLIER: 1.5,
  MARKET_CAP_LOWER_BOUND: 750_000,
  MARKET_CAP_UPPER_BOUND: 10_000_000,
  HIGH_MARKET_CAP_MULTIPLIER: 1.5,
  LIQUIDITY_DIVISOR: 1000,
};

/**
 * Calculate the liquidity multiplier based on the given liquidity amount.
 *
 * @param {number} liquidity - The liquidity amount to calculate the multiplier for.
 * @returns {number} The calculated liquidity multiplier.
 */
export function getLiquidityMultiplier(liquidity: number): number {
  liquidity = Math.max(0, liquidity);
  const multiplier = Math.sqrt(liquidity / BuyAmountConfig.LIQUIDITY_DIVISOR);
  return Math.min(multiplier, BuyAmountConfig.MAX_LIQUIDITY_MULTIPLIER);
}

/**
 * Calculates the volume multiplier based on the given volume.
 *
 * @param {number} volume The volume to calculate the multiplier for.
 * @returns {number} The calculated volume multiplier.
 */
export function getVolumeMultiplier(volume: number): number {
  volume = Math.max(0, volume);
  const multiplier = Math.log10(volume + 1);
  return Math.min(multiplier, BuyAmountConfig.MAX_VOLUME_MULTIPLIER);
}

/**
 * Calculates the market cap multiplier based on the current market cap.
 * If the current market cap is less than or equal to MARKET_CAP_LOWER_BOUND, returns 1.
 * If the current market cap is greater than or equal to MARKET_CAP_UPPER_BOUND, returns HIGH_MARKET_CAP_MULTIPLIER.
 * Otherwise, performs linear interpolation between 1 and HIGH_MARKET_CAP_MULTIPLIER based on the current market cap.
 *
 * @param {number} currentMarketCap The current market capitalization value.
 * @returns {number} The market cap multiplier.
 */

export function getMarketCapMultiplier(currentMarketCap: number): number {
  currentMarketCap = Math.max(0, currentMarketCap);

  if (currentMarketCap <= BuyAmountConfig.MARKET_CAP_LOWER_BOUND) {
    return 1;
  }
  if (currentMarketCap >= BuyAmountConfig.MARKET_CAP_UPPER_BOUND) {
    return BuyAmountConfig.HIGH_MARKET_CAP_MULTIPLIER;
  }
  // Linear interpolation between 1 and HIGH_MARKET_CAP_MULTIPLIER.
  const fraction =
    (currentMarketCap - BuyAmountConfig.MARKET_CAP_LOWER_BOUND) /
    (BuyAmountConfig.MARKET_CAP_UPPER_BOUND - BuyAmountConfig.MARKET_CAP_LOWER_BOUND);
  return 1 + fraction * (BuyAmountConfig.HIGH_MARKET_CAP_MULTIPLIER - 1);
}

/**
 * Calculates and returns the multiplier value based on the provided conviction level.
 * @param {("NONE" | "LOW" | "MEDIUM" | "HIGH")} conviction The conviction level.
 * @returns {number} The multiplier value corresponding to the input conviction level.
 */
export function getConvictionMultiplier(conviction: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH'): number {
  const multipliers = { NONE: 0.5, LOW: 1, MEDIUM: 1.5, HIGH: 2 };
  return multipliers[conviction];
}
