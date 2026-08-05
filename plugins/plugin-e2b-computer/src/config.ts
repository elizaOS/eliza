export type E2BComputerConfig = {
  apiKey: string | null;
  template: string;
  timeoutMs: number;
  enabled: boolean;
};

export function readE2BConfig(
  getSetting: (key: string) => string | undefined | null,
): E2BComputerConfig {
  const apiKey = (getSetting("E2B_API_KEY") || "").trim() || null;
  const enabledRaw = (getSetting("E2B_COMPUTER_ENABLED") || (apiKey ? "true" : "false"))
    .toString()
    .toLowerCase();
  return {
    apiKey,
    template: getSetting("E2B_TEMPLATE") || getSetting("E2B_SANDBOX_TEMPLATE") || "code-interpreter-v1",
    timeoutMs: Number(getSetting("E2B_TIMEOUT_MS") || 120_000) || 120_000,
    enabled: enabledRaw === "true" || enabledRaw === "1",
  };
}
