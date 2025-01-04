export const COIN_ID_MAPPING = {
    // Bitcoin variations
    btc: "bitcoin",
    bitcoin: "bitcoin",
    // Ethereum variations
    eth: "ethereum",
    ethereum: "ethereum",
    // USDC variations
    usdc: "usd-coin",
    "usd-coin": "usd-coin",
    // Add more mappings as needed
} as const;

/**
 * Normalizes a coin name/symbol to its CoinGecko ID
 * @param input The coin name or symbol to normalize
 * @returns The normalized CoinGecko ID or null if not found
 */
export function normalizeCoinId(input: string): string | null {
    const normalized = input.toLowerCase().trim();
    return COIN_ID_MAPPING[normalized] || null;
}
