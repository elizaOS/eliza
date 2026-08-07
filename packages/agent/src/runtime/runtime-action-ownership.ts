/**
 * Resolves the agent host's intentional action ownership overlaps without
 * weakening core's warning policy for unrelated plugins that claim the same
 * action name.
 */
import type { Action, IAgentRuntime, Plugin } from "@elizaos/core";

type ActionRegistryRuntime = Pick<IAgentRuntime, "actions" | "registerAction">;

const APP_CONTROL_PLUGIN = "@elizaos/plugin-app-control";
const HOST_SETTINGS_ACTION = "SETTINGS";

/**
 * The Eliza host SETTINGS action already composes the app-control settings
 * operations. Drop only that known duplicate when app-control is registered;
 * every other cross-plugin name collision still reaches core and warns.
 */
export function applyHostActionOwnership(
  runtime: Pick<IAgentRuntime, "actions">,
  plugin: Plugin,
): Plugin {
  if (
    plugin.name !== APP_CONTROL_PLUGIN ||
    !runtime.actions.some((action) => action.name === HOST_SETTINGS_ACTION) ||
    !plugin.actions?.some((action) => action.name === HOST_SETTINGS_ACTION)
  ) {
    return plugin;
  }

  return {
    ...plugin,
    actions: plugin.actions.filter(
      (action) => action.name !== HOST_SETTINGS_ACTION,
    ),
  };
}

/** Register a host fallback action only when no loaded plugin already owns it. */
export function registerFallbackActionIfAbsent(
  runtime: ActionRegistryRuntime,
  action: Action,
): boolean {
  if (runtime.actions.some((registered) => registered.name === action.name)) {
    return false;
  }
  runtime.registerAction(action);
  return true;
}
