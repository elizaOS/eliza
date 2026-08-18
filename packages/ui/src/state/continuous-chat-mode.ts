/**
 * Resolves persisted voice mode and the native-appliance bootstrap request.
 * URL input is untrusted: only an authenticated Electrobun renderer may use the
 * appliance query to choose always-on voice for a fresh profile.
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
  trustedNativeDesktop = false,
): ContinuousChatModeValue {
  if (stored !== null) return normalizeContinuousChatMode(stored);
  return trustedNativeDesktop &&
    new URLSearchParams(search).get("elizaOSAlwaysOnVoice") === "1"
    ? "always-on"
    : "off";
}
