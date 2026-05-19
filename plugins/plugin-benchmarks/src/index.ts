/**
 * Canonical eliza Action wrappers for benchmark tool vocabularies.
 *
 * The goal is to give every benchmark a single, stable eliza action shape so
 * that fine-tuning on benchmark traces produces consistent action names
 * regardless of which bench the trace came from.
 */

import type { Plugin } from "@elizaos/core";
import { promoteSubactionsToActions } from "@elizaos/core";

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
    ...promoteSubactionsToActions(vendingMachineAction),
    ...promoteSubactionsToActions(webshopAction),
    ...promoteSubactionsToActions(osworldAction),
    tauBenchToolAction,
    ...promoteSubactionsToActions(visualWebBenchTaskAction),
  ],
};

export default benchmarksPlugin;
