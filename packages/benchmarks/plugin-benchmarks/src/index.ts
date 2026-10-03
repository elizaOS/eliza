/**
 * Canonical eliza Action wrappers for benchmark tool vocabularies.
 *
 * The goal is to give every benchmark a single, stable eliza action shape so
 * that fine-tuning on benchmark traces produces consistent action names
 * regardless of which bench the trace came from.
 */

import type { Action, HandlerOptions, JsonValue, Plugin } from "@elizaos/core";
import { promoteSubactionsToActions } from "@elizaos/core";

/** Discriminator parameter names recognized across benchmark vocabularies. */
const DISCRIMINATOR_KEYS = ["action", "subaction", "op", "operation", "verb"] as const;

/**
 * Find the single value a promoted virtual's discriminator is pinned to
 * (its enum has exactly one entry after promotion), or undefined for
 * umbrella/unpinned actions.
 */
function pinnedDiscriminator(action: Action): { key: string; value: string } | undefined {
  for (const parameter of action.parameters ?? []) {
    if (!(DISCRIMINATOR_KEYS as readonly string[]).includes(parameter.name)) continue;
    const schema = parameter.schema as { enum?: unknown } | undefined;
    if (schema && Array.isArray(schema.enum) && schema.enum.length === 1) {
      const value = schema.enum[0];
      if (typeof value === "string") return { key: parameter.name, value };
    }
  }
  return undefined;
}

/**
 * `promoteSubactionsToActions` silently overwrites a caller-supplied
 * discriminator with the virtual's pinned value before dispatch. For
 * benchmark traces that silence is dangerous: a planner that calls
 * `VENDING_MACHINE_SET_PRICE` with `action: "restock_slot"` is confused,
 * and the trace should record the failure, not a rewritten success. Wrap
 * each virtual to reject contradictory discriminators loudly.
 */
function rejectContradictoryDiscriminator(actions: readonly Action[]): Action[] {
  return actions.map((action) => {
    const pinned = pinnedDiscriminator(action);
    if (!pinned) return action;
    const inner = action.handler;
    return {
      ...action,
      handler: async (runtime, message, state, options, callback, responses) => {
        const params = (options as HandlerOptions | undefined)?.parameters as
          | Record<string, JsonValue | undefined>
          | undefined;
        const supplied = params?.[pinned.key];
        if (supplied !== undefined && supplied !== pinned.value) {
          const text = `${action.name} is pinned to ${pinned.value}; got ${pinned.key}=${String(supplied)}. Call the matching virtual or the umbrella action instead.`;
          return { success: false, text, error: new Error(text) };
        }
        return inner(runtime, message, state, options, callback, responses);
      },
    };
  });
}

import { osworldAction } from "./actions/osworld";
import { tauBenchToolAction } from "./actions/tau-bench";
import { vendingMachineAction } from "./actions/vending-machine";
import { visualWebBenchTaskAction } from "./actions/visualwebbench";
import { webshopAction } from "./actions/webshop";

export { osworldAction } from "./actions/osworld";
export { tauBenchToolAction } from "./actions/tau-bench";
export { vendingMachineAction } from "./actions/vending-machine";
export { visualWebBenchTaskAction } from "./actions/visualwebbench";
export { webshopAction } from "./actions/webshop";

export const benchmarksPlugin: Plugin = {
  name: "benchmarks",
  description:
    "Canonical eliza Action wrappers for benchmark tool vocabularies (vending-bench, webshop, OSWorld, tau-bench, visualwebbench).",
  actions: [
    ...rejectContradictoryDiscriminator(promoteSubactionsToActions(vendingMachineAction)),
    ...rejectContradictoryDiscriminator(promoteSubactionsToActions(webshopAction)),
    ...rejectContradictoryDiscriminator(promoteSubactionsToActions(osworldAction)),
    tauBenchToolAction,
    ...rejectContradictoryDiscriminator(promoteSubactionsToActions(visualWebBenchTaskAction)),
  ],
};

export default benchmarksPlugin;
