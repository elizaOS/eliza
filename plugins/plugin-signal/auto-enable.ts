/**
 * Auto-enable gate for the Signal connector, referenced by package.json's
 * `elizaos.plugin.autoEnableModule`. Kept light — env/config reads only, no
 * service init, no transitive imports of the full plugin runtime — because the
 * auto-enable engine loads dozens of these modules per boot.
 */
import type { PluginAutoEnableContext } from "@elizaos/core";

/** The retired bridge never auto-enables. */
export function shouldEnable(_ctx: PluginAutoEnableContext): boolean {
  return false;
}
