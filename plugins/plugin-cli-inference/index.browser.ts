import type { Plugin } from "@elizaos/core";

/**
 * Browser stub. This plugin is node-only: it uses the `claude` CLI, Claude Agent
 * SDK, or `codex` CLI from a local Node process and reads creds from disk. The
 * browser bundle registers no models.
 */
export const cliInferencePlugin: Plugin = {
  name: "cli-inference",
  description:
    "CLI inference is node-only (claude CLI, claude-sdk, or codex CLI). Inert in browser.",
  config: {},
  async init(): Promise<void> {
    // Browser bundle intentionally does not import node:child_process.
  },
  models: {},
};

export default cliInferencePlugin;
