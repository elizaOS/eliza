import type { Plugin } from "@elizaos/core";

import { executeCodeAction } from "./action.js";

export const executeCodePlugin: Plugin = {
  name: "executecode",
  description:
    "Single EXECUTE_CODE action that runs a JS-style script with a tools Proxy and read-only runtime context. Use to chain three or more sequential actions in one trajectory step.",
  actions: [executeCodeAction],
  // Self-declared auto-enable: activate when features.executeCode is enabled.
  autoEnable: {
    shouldEnable: (_env, config) => {
      const f = (config?.features as Record<string, unknown> | undefined)
        ?.executeCode;
      return (
        f === true ||
        (typeof f === "object" &&
          f !== null &&
          (f as { enabled?: unknown }).enabled !== false)
      );
    },
  },
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
