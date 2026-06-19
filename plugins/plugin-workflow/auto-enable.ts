// Auto-enable check for @elizaos/plugin-workflow.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: config reads
// only, no service init, no transitive imports of the full plugin runtime.
import type { PluginAutoEnableContext } from '@elizaos/core';

/**
 * Default-on: enable workflows in-process unless the user's config has
 * `workflow.enabled === false` as a master switch. The central engine
 * additionally honors `plugins.entries.workflow.enabled === false`.
 */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const workflow = (ctx.config as Record<string, unknown> | undefined)?.workflow as
    | Record<string, unknown>
    | undefined;
  return workflow?.enabled !== false;
}
