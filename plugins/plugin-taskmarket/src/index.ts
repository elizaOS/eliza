/** Registers Taskmarket's read-only task-discovery capability with elizaOS. */

import type { Plugin } from "@elizaos/core";
import { browseTaskmarketTasksAction } from "./actions/browse-tasks.js";

export const taskmarketPlugin: Plugin = {
  name: "taskmarket",
  description:
    "Discover public Taskmarket tasks without wallet access or paid operations.",
  actions: [browseTaskmarketTasksAction],
};

export { browseTaskmarketTasksAction } from "./actions/browse-tasks.js";
export * from "./client.js";
export default taskmarketPlugin;
