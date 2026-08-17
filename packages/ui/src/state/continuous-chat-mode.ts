export type ContinuousChatModeValue = "off" | "vad-gated" | "always-on";

export function normalizeContinuousChatMode(
  value: unknown,
): ContinuousChatModeValue {
  if (value === "vad-gated" || value === "always-on") return value;
  return "off";
}

export function resolveContinuousChatMode(
  stored: string | null,
  search = "",
): ContinuousChatModeValue {
  if (stored !== null) return normalizeContinuousChatMode(stored);
  return new URLSearchParams(search).get("elizaOSAlwaysOnVoice") === "1"
    ? "always-on"
    : "off";
}
