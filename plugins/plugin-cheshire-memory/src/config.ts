export type CheshireMemoryConfig = {
  hermesApiKey: string | null;
  hermesBaseUrl: string;
  honchoApiKey: string | null;
  honchoBaseUrl: string;
  peerId: string;
  sessionId: string;
  tradingMemoryEnabled: boolean;
};

export function readCheshireMemoryConfig(
  getSetting: (key: string) => string | undefined | null,
): CheshireMemoryConfig {
  const hermesApiKey = (getSetting("HERMES_API_KEY") || "").trim() || null;
  const honchoApiKey = (getSetting("HONCHO_API_KEY") || "").trim() || null;
  return {
    hermesApiKey,
    hermesBaseUrl:
      getSetting("HERMES_API_URL") ||
      getSetting("HERMES_BASE_URL") ||
      "https://api.hermes.local",
    honchoApiKey,
    honchoBaseUrl:
      getSetting("HONCHO_BASE_URL") ||
      getSetting("HONCHO_API_URL") ||
      "https://api.honcho.dev",
    peerId: getSetting("HONCHO_PEER_ID") || getSetting("AGENT_NAME") || "cheshire-agent",
    sessionId: getSetting("HONCHO_SESSION_ID") || "cheshire-default",
    tradingMemoryEnabled:
      (getSetting("CHESHIRE_TRADING_MEMORY") || "true").toString().toLowerCase() !== "false",
  };
}

export function memoryBackendStatus(cfg: CheshireMemoryConfig): {
  hermes: "configured" | "missing";
  honcho: "configured" | "missing";
} {
  return {
    hermes: cfg.hermesApiKey ? "configured" : "missing",
    honcho: cfg.honchoApiKey ? "configured" : "missing",
  };
}
