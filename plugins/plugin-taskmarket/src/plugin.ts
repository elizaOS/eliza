/**
 * Plugin object for `@elizaos/plugin-taskmarket`: registers the read-only
 * discovery/status actions and the spend-guarded task-creation action that let
 * an Eliza agent delegate work to the TaskMarket worker marketplace instead of
 * burning more inference on a task another worker can do.
 */
import type { Plugin } from "@elizaos/core";
import { taskMarketBrowseAction } from "./actions/browse.ts";
import { taskMarketCreateTaskAction } from "./actions/create-task.ts";
import { taskMarketStatusAction } from "./actions/status.ts";

export const taskMarketPlugin: Plugin = {
  name: "@elizaos/plugin-taskmarket",
  description:
    "Delegate work to the TaskMarket agent marketplace (USDC on Base): browse open tasks, track your own submissions and balance, and — only when explicitly enabled, bounded and user-confirmed — post a task that escrows USDC.",
  actions: [
    taskMarketBrowseAction,
    taskMarketStatusAction,
    taskMarketCreateTaskAction,
  ],
};
