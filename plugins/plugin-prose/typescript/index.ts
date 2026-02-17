import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

import { proseCompileAction } from "./actions/compile";
import { proseHelpAction } from "./actions/help";
import { proseRunAction } from "./actions/run";
import { initProseService, proseProvider } from "./providers/prose";

export * from "./types";
export { ProseService, createProseService, setSkillContent } from "./services/proseService";
export { proseProvider, initProseService };
export { proseRunAction, proseCompileAction, proseHelpAction };

/**
 * plugin-prose: OpenProse VM integration for elizaOS
 *
 * OpenProse is a programming language for AI sessions that allows
 * orchestrating multi-agent workflows. When a prose program is run,
 * the agent "becomes" the OpenProse VM and executes the program.
 *
 * ## Actions
 * - PROSE_RUN: Execute a .prose program
 * - PROSE_COMPILE: Validate a .prose program without running
 * - PROSE_HELP: Get help with OpenProse syntax and examples
 *
 * ## Provider
 * - prose: Provides VM context when prose commands are detected
 *
 * ## Configuration
 * - PROSE_WORKSPACE_DIR: Base directory for .prose workspace (default: ".prose")
 * - PROSE_STATE_MODE: Default state mode (filesystem|in-context|sqlite|postgres)
 * - PROSE_SKILLS_DIR: Directory containing prose skill files
 */
export const prosePlugin: Plugin = {
  name: "plugin-prose",
  description: "OpenProse VM integration - a programming language for AI sessions",

  actions: [proseRunAction, proseCompileAction, proseHelpAction],

  providers: [proseProvider],

  async init(runtime: IAgentRuntime): Promise<void> {
    logger.info("[plugin-prose] Initializing OpenProse VM plugin");

    // Get skills directory if configured
    const skillsDir = runtime.getSetting("PROSE_SKILLS_DIR");

    if (skillsDir) {
      try {
        await initProseService(runtime, skillsDir);
        logger.info(`[plugin-prose] Loaded skill files from ${skillsDir}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`[plugin-prose] Could not load skill files: ${msg}`);
      }
    } else {
      logger.info("[plugin-prose] No PROSE_SKILLS_DIR configured - using embedded reference");
    }

    logger.info("[plugin-prose] OpenProse VM ready");
  },
};

export default prosePlugin;
