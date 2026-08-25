/** First-party DoorDash plugin backed by the shared MCP connection service. */

import type { Plugin } from "@elizaos/core";
import { doorDashAction } from "./action.js";

export const doorDashPlugin: Plugin = {
  name: "doordash",
  description:
    "DoorDash consumer ordering through a configured MCP adapter with explicit checkout confirmation.",
  dependencies: ["@elizaos/plugin-mcp"],
  actions: [doorDashAction],
};

export default doorDashPlugin;
export { checkoutPreviewDigest, doorDashAction } from "./action.js";
export { callDoorDashOperation, hasDoorDashCapability } from "./adapter.js";
export * from "./types.js";
