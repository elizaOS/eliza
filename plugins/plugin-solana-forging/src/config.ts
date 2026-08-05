export type SolanaForgeConfig = {
  rpcUrl: string;
  collectionMint: string;
  liveEnabled: boolean;
  cheshireApiBase: string;
  /** Optional dual-rail: also prepare RH link intent */
  omniEnabled: boolean;
};

export function readSolanaForgeConfig(
  getSetting: (key: string) => string | undefined | null,
): SolanaForgeConfig {
  const liveRaw = (getSetting("SOLANA_FORGE_LIVE") || getSetting("CLAWD_LIVE") || "false")
    .toString()
    .toLowerCase();
  const omniRaw = (getSetting("CHESHIRE_OMNI_MINT") || "false").toString().toLowerCase();
  return {
    rpcUrl:
      getSetting("SOLANA_RPC_URL") ||
      getSetting("HELIUS_RPC_URL") ||
      "https://api.mainnet-beta.solana.com",
    collectionMint: getSetting("METAPLEX_AGENT_COLLECTION") || getSetting("CLAWD_COLLECTION") || "",
    liveEnabled: liveRaw === "true" || liveRaw === "1",
    cheshireApiBase:
      getSetting("CHESHIRE_API_URL") ||
      getSetting("PUBLIC_API_URL") ||
      "https://cheshireterminal.ai",
    omniEnabled: omniRaw === "true" || omniRaw === "1",
  };
}
