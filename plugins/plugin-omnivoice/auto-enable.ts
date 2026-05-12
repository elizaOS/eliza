// Auto-enable check for @elizaos/plugin-omnivoice.
//
// Activate when the user has explicitly enabled local TTS or has set
// OMNIVOICE_MODEL_PATH (the GGUF must be present for synthesis to be
// attempted at all). Kept light per the manifest contract — env reads
// only, no transitive imports of the runtime plugin.
import type { PluginAutoEnableContext } from "@elizaos/core";

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

/**
 * Enable when the user has explicitly opted into local TTS (`features.tts`
 * with `provider: "omnivoice"` or `features.localTts === true`) or has
 * provided the model paths via env. Avoid auto-enabling on every tts user;
 * cloud / Edge TTS remain the safe default.
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
    if (typeof provider === "string" && provider.toLowerCase() === "omnivoice") {
      return true;
    }
  }
  return false;
}
