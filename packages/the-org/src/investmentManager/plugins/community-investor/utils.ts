import { XMLParser } from "fast-xml-parser";
import type { ZodType } from "zod";
import zodToJsonSchema from "zod-to-json-schema";


export function getZodJsonSchema(schema: ZodType<any>) {
    return zodToJsonSchema(schema, "schema").definitions?.schema;
}

export function extractXMLFromResponse(output: string, tag: string) {
    const start = output.indexOf(`<${tag}>`);
    const end = output.indexOf(`</${tag}>`) + `</${tag}>`.length;

    if (start === -1 || end === -1) {
        return "";
    }

    return output.slice(start, end);
}

export function parseRecommendationsResponse(xmlResponse: string) {
    const parser = new XMLParser({
        ignoreAttributes: false,
        isArray: (name) => name === "recommendation", // Treat individual recommendations as array elements
    });
    const result = parser.parse(xmlResponse);
    return result.new_recommendations?.recommendation || []; // Access the nested array structure
}

export function parseTokensResponse(xmlResponse: string) {
    const parser = new XMLParser({
        ignoreAttributes: false,
        isArray: (name) => name === "tokenAddress", // Treat individual recommendations as array elements
    });
    const result = parser.parse(xmlResponse);
    return result.tokens.tokenAddress || []; // Access the nested array structure
}

export function parseConfirmationResponse(xmlResponse: string) {
    const parser = new XMLParser({
        ignoreAttributes: false,
    });
    const result = parser.parse(xmlResponse);
    return result.message || "";
}

export function parseSignalResponse(xmlResponse: string) {
    const parser = new XMLParser({
        ignoreAttributes: false,
    });
    const result = parser.parse(xmlResponse);
    return result.signal;
}

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

export function getLiquidityMultiplier(liquidity: number): number {
    liquidity = Math.max(0, liquidity);
    const multiplier = Math.sqrt(liquidity / BuyAmountConfig.LIQUIDITY_DIVISOR);
    return Math.min(multiplier, BuyAmountConfig.MAX_LIQUIDITY_MULTIPLIER);
}

export function getVolumeMultiplier(volume: number): number {
    volume = Math.max(0, volume);
    const multiplier = Math.log10(volume + 1);
    return Math.min(multiplier, BuyAmountConfig.MAX_VOLUME_MULTIPLIER);
}

export function getMarketCapMultiplier(currentMarketCap: number): number {
    currentMarketCap = Math.max(0, currentMarketCap);

    if (currentMarketCap <= BuyAmountConfig.MARKET_CAP_LOWER_BOUND) {
        return 1;
    }if (currentMarketCap >= BuyAmountConfig.MARKET_CAP_UPPER_BOUND) {
        return BuyAmountConfig.HIGH_MARKET_CAP_MULTIPLIER;
    }
        // Linear interpolation between 1 and HIGH_MARKET_CAP_MULTIPLIER.
        const fraction =
            (currentMarketCap - BuyAmountConfig.MARKET_CAP_LOWER_BOUND) /
            (BuyAmountConfig.MARKET_CAP_UPPER_BOUND -
                BuyAmountConfig.MARKET_CAP_LOWER_BOUND);
        return 1 + fraction * (BuyAmountConfig.HIGH_MARKET_CAP_MULTIPLIER - 1);
}

export function getConvictionMultiplier(
    conviction: "NONE" | "LOW" | "MEDIUM" | "HIGH"
): number {
    const multipliers = { NONE: 0.5, LOW: 1, MEDIUM: 1.5, HIGH: 2 };
    return multipliers[conviction];
}
