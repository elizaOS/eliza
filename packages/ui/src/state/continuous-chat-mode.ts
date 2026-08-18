/**
 * Resolves persisted voice mode and the native-appliance bootstrap request.
 * URL input is untrusted and cannot enable capture without a native host.
 */
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
  trustedApplianceHost = false,
): ContinuousChatModeValue {
  if (stored !== null) return normalizeContinuousChatMode(stored);
  return trustedApplianceHost &&
    new URLSearchParams(search).get("elizaOSAlwaysOnVoice") === "1"
    ? "always-on"
    : "off";
}
