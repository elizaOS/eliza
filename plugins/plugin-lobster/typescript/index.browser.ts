/**
 * Browser entry point for plugin-lobster
 *
 * Note: Lobster requires Node.js subprocess execution.
 * This browser entry provides a stub.
 */
import type { Plugin } from "@elizaos/core";

export const lobsterPlugin: Plugin = {
  name: "lobster",
  description: "Lobster workflow runtime (Node.js only - not available in browser).",

  providers: [],
  actions: [],

  async init(): Promise<void> {
    console.warn("[LobsterPlugin] This plugin is not available in browser context.");
  },
};

export default lobsterPlugin;

// Re-export types for type-checking
export type {
  LobsterApprovalRequest,
  LobsterConfig,
  LobsterEnvelope,
  LobsterErrorEnvelope,
  LobsterResumeParams,
  LobsterRunParams,
  LobsterSuccessEnvelope,
} from "./types";
