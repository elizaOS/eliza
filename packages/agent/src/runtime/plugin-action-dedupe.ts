/**
 * Action-name dedupe for the ordered plugin set assembled during agent boot.
 * The runtime registers actions by name, so boot composition removes later
 * duplicates deterministically before registration while preserving the first
 * plugin's action surface.
 */
import { logger, type Plugin } from "@elizaos/core";

/**
 * Remove duplicate actions across an ordered list of plugins.
 *
 * When multiple plugins define an action with the same `name`, only the first
 * occurrence is kept. This prevents "Action already registered" warnings from
 * elizaOS core. The function mutates each plugin's `actions` array in place.
 */
export function deduplicatePluginActions(plugins: Plugin[]): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (plugin.actions) {
      plugin.actions = plugin.actions.filter((action) => {
        if (seen.has(action.name)) {
          logger.debug(
            `[eliza] Skipping duplicate action "${action.name}" from plugin "${plugin.name}"`,
          );
          return false;
        }
        seen.add(action.name);
        return true;
      });
    }
  }
}
