import type { Plugin } from "@elizaos/core";
import { registerRobinhoodAgentAction } from "./actions/register-agent.js";

export { buildRegisterAgentIntent, registerRobinhoodAgentAction } from "./actions/register-agent.js";
export { readRobinhoodConfig, validateForgeReadiness } from "./config.js";
export type { RobinhoodForgeConfig } from "./config.js";

export const robinhoodPlugin: Plugin = {
  name: "@elizaos/plugin-robinhood",
  description:
    "Cheshire Terminal Robinhood Chain forge — ERC-8004 identity registration intents (preview-first, no silent live writes).",
  actions: [registerRobinhoodAgentAction],
  providers: [],
  services: [],
};

export default robinhoodPlugin;
