import type { Plugin } from "@elizaos/core";
import { echoAction } from "./actions/echo.ts";

/**
 * Reference third-party elizaOS plugin. Single ECHO action; no config, no
 * services. Used as the worked example in the community registry docs.
 */
export const echoPlugin: Plugin = {
  name: "echo",
  description: "Reference third-party plugin with a single ECHO action.",
  actions: [echoAction],
};

export { echoAction } from "./actions/echo.ts";
export default echoPlugin;
