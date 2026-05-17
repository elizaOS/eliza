// Auto-enable check for @elizaos/plugin-streaming.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: config reads
// only, no service init, no transitive imports of the full plugin runtime.
import type { PluginAutoEnableContext } from "@elizaos/core";

const DESTS = [
  "twitch",
  "youtube",
  "customRtmp",
  "pumpfun",
  "x",
  "rtmpSources",
] as const;

function isDestConfigured(name: string, raw: unknown): boolean {
  if (name === "rtmpSources") {
    if (!Array.isArray(raw)) return false;
    return (raw as unknown[]).some((row) => {
      if (!row || typeof row !== "object") return false;
      const r = row as Record<string, unknown>;
      const id = String(r.id ?? "").trim();
      const url = String(r.rtmpUrl ?? "").trim();
      const key = String(r.rtmpKey ?? "").trim();
      return Boolean(id && url && key);
    });
  }

  if (!raw || typeof raw !== "object") return false;
  const c = raw as Record<string, unknown>;
  if (c.enabled === false) return false;

  switch (name) {
    case "twitch":
    case "youtube":
      return Boolean(c.streamKey || c.enabled === true);
    case "customRtmp":
      return Boolean(c.rtmpUrl && c.rtmpKey);
    case "pumpfun":
    case "x":
      return Boolean(c.streamKey && c.rtmpUrl);
    default:
      return false;
  }
}

/** Enable when any streaming destination is configured. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const streaming = (ctx.config as Record<string, unknown> | undefined)
    ?.streaming as Record<string, unknown> | undefined;
  if (!streaming) return false;
  return DESTS.some((d) => isDestConfigured(d, streaming[d]));
}
