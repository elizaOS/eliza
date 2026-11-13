/** Resolves the persisted continuous voice chat mode. */
export type ContinuousChatModeValue = "off" | "vad-gated" | "always-on";

export function normalizeContinuousChatMode(
  value: unknown,
): ContinuousChatModeValue {
  if (value === "vad-gated" || value === "always-on") return value;
  return "off";
}

export function resolveContinuousChatMode(
  stored: string | null,
): ContinuousChatModeValue {
  return stored === null ? "off" : normalizeContinuousChatMode(stored);
}
