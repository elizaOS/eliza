/**
 * Browser entry point for plugin-prose
 *
 * Note: OpenProse relies on filesystem access and is primarily
 * intended for Node.js environments. This browser entry provides
 * stub implementations for documentation purposes.
 */

import type { Action, IAgentRuntime, Memory, Plugin, Provider, State } from "@elizaos/core";
import { logger } from "@elizaos/core";

export * from "./types";

// Stub provider for browser
const browserProseProvider: Provider = {
  name: "prose",
  description: "OpenProse VM (not available in browser)",
  get: async () => {
    return "OpenProse VM requires Node.js for filesystem access. Please use a server-side environment.";
  },
};

// Stub action for browser
function createBrowserStubAction(name: string, description: string): Action {
  return {
    name,
    description,
    similes: [],
    examples: [],
    validate: async () => false,
    handler: async (
      _runtime: IAgentRuntime,
      _message: Memory,
      _state: State | undefined,
      _options: Record<string, unknown>,
      callback?: (response: { text: string; actions: string[] }) => void
    ) => {
      if (callback) {
        callback({
          text: `${name} requires Node.js for filesystem access.`,
          actions: [],
        });
      }
      return false;
    },
  };
}

export const prosePlugin: Plugin = {
  name: "plugin-prose",
  description: "OpenProse VM integration (browser stub)",

  actions: [
    createBrowserStubAction("PROSE_RUN", "Execute OpenProse program"),
    createBrowserStubAction("PROSE_COMPILE", "Validate OpenProse program"),
    createBrowserStubAction("PROSE_HELP", "Get OpenProse help"),
  ],

  providers: [browserProseProvider],

  async init(): Promise<void> {
    logger.warn("[plugin-prose] Running in browser - functionality limited");
  },
};

export default prosePlugin;
