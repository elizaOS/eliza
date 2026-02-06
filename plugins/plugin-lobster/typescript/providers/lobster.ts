import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import { createLobsterService } from "../services/lobsterService";

/**
 * Provider that exposes Lobster availability status to the agent's context.
 */
export const lobsterProvider: Provider = {
  name: "lobster",
  description:
    "Provides information about Lobster workflow runtime availability. Lobster runs deterministic multi-step pipelines with approval checkpoints.",

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    try {
      const service = createLobsterService(runtime);
      const isAvailable = await service.isAvailable();

      if (!isAvailable) {
        return {
          text: "Lobster workflow runtime is not available. Install Lobster to enable pipeline workflows.",
          data: { available: false },
          values: { lobsterAvailable: false },
        };
      }

      const helpText = `**Lobster Workflow Runtime** is available.

Lobster executes multi-step workflows with approval checkpoints. Use it when:
- User wants a repeatable automation (triage, monitor, sync)
- Actions need human approval before executing (send, post, delete)
- Multiple tool calls should run as one deterministic operation

Example pipelines:
- \`gog.gmail.search --query 'newer_than:1d' | email.triage\` - Triage recent emails
- \`github.pr.list --state open | pr.review\` - Review open PRs
- \`rss.fetch --url "..." | content.summarize\` - Summarize RSS feeds

Use LOBSTER_RUN to execute a pipeline, LOBSTER_RESUME to continue after approval.`;

      return {
        text: helpText,
        data: { available: true },
        values: { lobsterAvailable: true },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("[LobsterProvider] Error:", errorMsg);
      return {
        text: "Lobster status unavailable.",
        data: { error: errorMsg },
        values: { lobsterAvailable: false },
      };
    }
  },
};

export default lobsterProvider;
