/**
 * Resolves the agent host's intentional action ownership overlaps without
 * weakening core's warning policy for unrelated plugins that claim the same
 * action name.
 */
import type { Action, IAgentRuntime } from "@elizaos/core";

type ActionRegistryRuntime = Pick<IAgentRuntime, "actions" | "registerAction">;

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
