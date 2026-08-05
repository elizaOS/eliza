/**
 * Robinhood Chain forge env surface for Cheshire Terminal agents.
 * Secrets stay in runtime settings — never log private keys.
 */

export type RobinhoodForgeConfig = {
  rpcUrl: string;
  chainId: number;
  identityRegistry: string;
  reputationRegistry: string;
  validationRegistry: string;
  /** When false, actions only return unsigned intents / previews */
  liveEnabled: boolean;
  cheshireApiBase: string;
};

const DEFAULT_CHAIN_ID = 4663;

export function readRobinhoodConfig(
  getSetting: (key: string) => string | undefined | null,
): RobinhoodForgeConfig {
  const liveRaw = (getSetting("ROBINHOOD_LIVE") || getSetting("CLAWD_LIVE") || "false")
    .toString()
    .toLowerCase();
  return {
    rpcUrl:
      getSetting("ROBINHOOD_RPC_URL") ||
      getSetting("RH_RPC_URL") ||
      "https://rpc.robinhood.xyz",
    chainId: Number(getSetting("ROBINHOOD_CHAIN_ID") || DEFAULT_CHAIN_ID) || DEFAULT_CHAIN_ID,
    identityRegistry: getSetting("CHESHIRE_IDENTITY_REGISTRY") || "",
    reputationRegistry: getSetting("CHESHIRE_REPUTATION_REGISTRY") || "",
    validationRegistry: getSetting("CHESHIRE_VALIDATION_REGISTRY") || "",
    liveEnabled: liveRaw === "true" || liveRaw === "1" || liveRaw === "yes",
    cheshireApiBase:
      getSetting("CHESHIRE_API_URL") ||
      getSetting("PUBLIC_API_URL") ||
      "https://cheshireterminal.ai",
  };
}

export function validateForgeReadiness(cfg: RobinhoodForgeConfig): string[] {
  const missing: string[] = [];
  if (!cfg.rpcUrl) missing.push("ROBINHOOD_RPC_URL");
  if (!cfg.identityRegistry) missing.push("CHESHIRE_IDENTITY_REGISTRY");
  return missing;
}
