import type { IAgentRuntime, SearchCategoryRegistration } from "@elizaos/core";

export const DEXSCREENER_SEARCH_CATEGORY: SearchCategoryRegistration = {
  category: "dexscreener",
  label: "DexScreener token search",
  description:
    "Search DexScreener for tokens and trading pairs by name, symbol, or contract address.",
  contexts: ["wallet", "knowledge"],
  filters: [
    { name: "query", label: "Query", type: "string", required: true },
    {
      name: "limit",
      label: "Limit",
      description: "Maximum pairs to return.",
      type: "number",
      default: 5,
    },
  ],
  resultSchemaSummary:
    "DexScreenerPair[] with chainId, dexId, url, baseToken, quoteToken, price, priceChange, volume, liquidity, marketCap, and fdv.",
  capabilities: ["tokens", "pairs", "dex-liquidity", "market-data"],
  source: "plugin:wallet:dexscreener",
  serviceType: "dexscreener",
};

function hasSearchCategory(runtime: IAgentRuntime, category: string): boolean {
  try {
    runtime.getSearchCategory(category, { includeDisabled: true });
    return true;
  } catch {
    return false;
  }
}

export function registerDexScreenerSearchCategory(
  runtime: IAgentRuntime,
): void {
  if (!hasSearchCategory(runtime, DEXSCREENER_SEARCH_CATEGORY.category)) {
    runtime.registerSearchCategory(DEXSCREENER_SEARCH_CATEGORY);
  }
}
