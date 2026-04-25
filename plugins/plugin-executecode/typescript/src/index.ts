import type { Plugin } from "@elizaos/core";

import { executeCodeAction } from "./action.js";

export const executeCodePlugin: Plugin = {
  name: "executecode",
  description:
    "Single EXECUTE_CODE action that runs a JS-style script with a tools Proxy and read-only runtime context. Use to chain three or more sequential actions in one trajectory step.",
  actions: [executeCodeAction],
};

export default executeCodePlugin;

export { executeCodeAction } from "./action.js";
export {
  buildScriptContext,
  buildToolsProxy,
  type ScriptContext,
  type ToolArgs,
  type ToolCallResult,
  type ToolsProxy,
} from "./rpc-bridge.js";
