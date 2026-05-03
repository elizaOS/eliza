import type { Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { z } from "zod";
import { claudeCodeWorkbenchListAction } from "./actions/list-workflows.ts";
import { claudeCodeWorkbenchRunAction } from "./actions/run-workflow.ts";
import { loadClaudeCodeWorkbenchConfig } from "./config.ts";
import { claudeCodeWorkbenchStatusProvider } from "./providers/status.ts";
import { claudeCodeWorkbenchRoutes } from "./routes.ts";
import { ClaudeCodeWorkbenchService } from "./services/workbench-service.ts";

export const claudeCodeWorkbenchPlugin: Plugin = {
  name: "claude-code-workbench",
  description:
    "Claude Code companion for this repository. Adds secure, allowlisted repo workflows via service, actions, provider, and API routes.",

  get config() {
    return {
      CLAUDE_CODE_WORKBENCH_WORKSPACE_ROOT:
        process.env.CLAUDE_CODE_WORKBENCH_WORKSPACE_ROOT ?? null,
      CLAUDE_CODE_WORKBENCH_TIMEOUT_MS:
        process.env.CLAUDE_CODE_WORKBENCH_TIMEOUT_MS ?? null,
      CLAUDE_CODE_WORKBENCH_MAX_OUTPUT_CHARS:
        process.env.CLAUDE_CODE_WORKBENCH_MAX_OUTPUT_CHARS ?? null,
      CLAUDE_CODE_WORKBENCH_MAX_STDIN_BYTES:
        process.env.CLAUDE_CODE_WORKBENCH_MAX_STDIN_BYTES ?? null,
      CLAUDE_CODE_WORKBENCH_ALLOWED_WORKFLOWS:
        process.env.CLAUDE_CODE_WORKBENCH_ALLOWED_WORKFLOWS ?? null,
      CLAUDE_CODE_WORKBENCH_ENABLE_MUTATING_WORKFLOWS:
        process.env.CLAUDE_CODE_WORKBENCH_ENABLE_MUTATING_WORKFLOWS ?? null,
    };
  },

  async init(config: Record<string, string>) {
    logger.info("Claude Code workbench: initializing plugin");

    try {
      const normalized = loadClaudeCodeWorkbenchConfig(config);

      for (const [key, value] of Object.entries(config)) {
        if (!key.startsWith("CLAUDE_CODE_WORKBENCH_")) {
          continue;
        }

        if (value) {
          process.env[key] = value;
        }
      }

      logger.info(
        `Claude Code workbench: initialized (root=${normalized.workspaceRoot}, workflows=${normalized.allowedWorkflowIds.join(",")})`,
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues =
          error.issues?.map((issue) => issue.message).join(", ") ||
          "Unknown validation error";
        throw new Error(`Claude Code workbench configuration error: ${issues}`);
      }

      throw new Error(
        `Claude Code workbench initialization failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  },

  services: [ClaudeCodeWorkbenchService],
  actions: [claudeCodeWorkbenchRunAction, claudeCodeWorkbenchListAction],
  providers: [claudeCodeWorkbenchStatusProvider],
  routes: claudeCodeWorkbenchRoutes,
};

export default claudeCodeWorkbenchPlugin;
