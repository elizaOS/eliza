/**
 * CLOUD_LIST_AGENTS — answer "what agents do I have hosted on Eliza Cloud?".
 *
 * Read-only inventory over `GET /api/v1/eliza/agents` via the typed SDK with
 * the runtime's org API key. Formats name + status lines and handles the
 * empty / signed-out / error paths with honest, distinct replies. `validate`
 * drops the action from the planner tool list when the agent is not
 * cloud-connected; the handler re-guards (validate is advisory).
 */

import type { AgentListItemDto } from "@elizaos/cloud-sdk";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { createElizaCloudClient } from "../utils/sdk-client";
import { cloudAccountAuthenticated, NO_CLOUD_MESSAGE } from "./cloud-account-status";

const EMPTY_MESSAGE =
  "You don't have any agents hosted on Eliza Cloud yet. You can provision one from the Cloud console, or ask me to create one.";
const ERROR_MESSAGE =
  "I couldn't fetch your Eliza Cloud agents right now — the Cloud API returned an error. Try again in a moment.";

function formatAgentLine(agent: AgentListItemDto): string {
  return `• ${agent.agentName ?? agent.id} — ${agent.status}`;
}

export const listCloudAgentsAction: Action = {
  name: "CLOUD_LIST_AGENTS",
  similes: ["MY_CLOUD_AGENTS", "SHOW_HOSTED_AGENTS", "LIST_HOSTED_AGENTS"],
  description:
    "List the agents the user has hosted on Eliza Cloud (name and status). Use when the user asks what agents they have in the cloud, their hosted agents, or whether their cloud agents are running.",
  descriptionCompressed: "List the user's hosted Eliza Cloud agents.",
  contexts: ["cloud", "settings"],

  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    cloudAccountAuthenticated(runtime),

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    if (!cloudAccountAuthenticated(runtime)) {
      await callback?.({ text: NO_CLOUD_MESSAGE, actions: ["CLOUD_LIST_AGENTS"] });
      return {
        success: false,
        text: "Not connected to Eliza Cloud.",
        userFacingText: NO_CLOUD_MESSAGE,
        data: { reason: "not_connected" },
      };
    }

    try {
      const { data: agents } = await createElizaCloudClient(runtime).listAgents();

      if (agents.length === 0) {
        await callback?.({ text: EMPTY_MESSAGE, actions: ["CLOUD_LIST_AGENTS"] });
        return {
          success: true,
          text: "User has no hosted Eliza Cloud agents.",
          userFacingText: EMPTY_MESSAGE,
          data: { count: 0, agents: [] },
        };
      }

      const header =
        agents.length === 1
          ? "You have 1 agent hosted on Eliza Cloud:"
          : `You have ${agents.length} agents hosted on Eliza Cloud:`;
      const reply = `${header}\n${agents.map(formatAgentLine).join("\n")}`;

      await callback?.({ text: reply, actions: ["CLOUD_LIST_AGENTS"] });
      return {
        success: true,
        text: `Listed ${agents.length} hosted Eliza Cloud agent(s).`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          count: agents.length,
          agents: agents.map((agent) => ({
            id: agent.id,
            name: agent.agentName,
            status: agent.status,
          })),
        },
      };
    } catch (err) {
      logger.warn(
        `[CLOUD_LIST_AGENTS] Failed to list agents: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["CLOUD_LIST_AGENTS"] });
      return {
        success: false,
        text: "Failed to list Eliza Cloud agents.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "what agents do I have on eliza cloud?" } },
      {
        name: "{{agent}}",
        content: {
          text: "You have 2 agents hosted on Eliza Cloud:\n• trading-bot — running\n• support-agent — stopped",
          actions: ["CLOUD_LIST_AGENTS"],
        },
      },
    ],
    [
      { name: "{{user}}", content: { text: "are my hosted agents running?" } },
      {
        name: "{{agent}}",
        content: {
          text: "You have 1 agent hosted on Eliza Cloud:\n• trading-bot — running",
          actions: ["CLOUD_LIST_AGENTS"],
        },
      },
    ],
  ],
};

export default listCloudAgentsAction;
