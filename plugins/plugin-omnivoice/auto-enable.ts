// Auto-enable check for @elizaos/plugin-omnivoice.
//
// Activate when the user has explicitly enabled local TTS, set
// OMNIVOICE_MODEL_PATH (the GGUF must be present for synthesis to be
// attempted at all), OR has staged converted GGUFs under the conventional
// `<stateDir>/models/omnivoice/speech/` directory. Filesystem discovery
// can be disabled via `OMNIVOICE_AUTO_DETECT=0`.
//
// Kept light per the manifest contract — env reads + sync filesystem
// reads only, no transitive imports of the runtime plugin.
import type { PluginAutoEnableContext } from "@elizaos/core";
import { discoverOmnivoiceModels } from "./src/discover";

function isFeatureEnabled(
  config: PluginAutoEnableContext["config"],
  key: string,
): boolean {
  const f = (config?.features as Record<string, unknown> | undefined)?.[key];
  if (f === true) return true;
  if (f && typeof f === "object" && f !== null) {
    return (f as Record<string, unknown>).enabled !== false;
  }
  return false;
}

function autoDetectDisabled(env: PluginAutoEnableContext["env"]): boolean {
  const raw = env.OMNIVOICE_AUTO_DETECT;
  if (typeof raw !== "string") return false;
  const lower = raw.trim().toLowerCase();
  return lower === "0" || lower === "false" || lower === "no";
}

/**
 * Enable when the user has explicitly opted into local TTS (`features.tts`
 * with `provider: "omnivoice"` or `features.localTts === true`), has
 * provided the model paths via env, or has staged converted GGUFs at
 * `<stateDir>/models/omnivoice/speech/`. Avoid auto-enabling on every tts
 * user; cloud / Edge TTS remain the safe default unless artifacts exist.
 */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  if (ctx.env.OMNIVOICE_MODEL_PATH && ctx.env.OMNIVOICE_CODEC_PATH) {
    return true;
  }
  if (isFeatureEnabled(ctx.config, "localTts")) return true;
  const tts = (ctx.config?.features as Record<string, unknown> | undefined)
    ?.tts;
  if (tts && typeof tts === "object" && tts !== null) {
    const provider = (tts as Record<string, unknown>).provider;
    if (
      typeof provider === "string" &&
      provider.toLowerCase() === "omnivoice"
    ) {
      return true;
    }
  }
  if (!autoDetectDisabled(ctx.env)) {
    try {
      const discovered = discoverOmnivoiceModels();
      if (discovered.speech) return true;
    } catch {
      // Filesystem discovery is best-effort; never throw out of the
      // auto-enable probe.
    }
  }
  return false;
}
