/** Compatibility entrypoint for wallet-owned price readers. */
export {
  computeValueUsd,
  DEX_PRICE_TIMEOUT_MS,
  DEXPAPRIKA_CHAIN_MAP,
  DEXSCREENER_CHAIN_MAP,
  type DexScreenerPair,
  type DexTokenMeta,
  fetchDexPaprikaPrices,
  fetchDexPrices,
  fetchDexScreenerPrices,
  WRAPPED_NATIVE,
} from "@elizaos/plugin-wallet/read";
