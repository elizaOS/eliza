/**
 * DISPATCH_TO_AGENT Action
 *
 * Allows the coordinator to execute a command on behalf of the user
 * by dispatching it to a specific agent in their team.
 *
 * The broadcastFn dependency is injected via state.data from the route layer
 * to avoid importing @feed/api from packages/agents.
 *
 * Key implementation notes:
 * - Returns ActionResult AND calls _callback (so processActions can
 *   relay the result to the coordinator route's callback handler)
 * - validate() only shows this action when the team has at least one agent
 *   (reads from state.data.teamMembers populated by coordinatorTeamMembersProvider)
 * - state.data.actionParams is the established pattern for passing params to handlers
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { defineActionParameters } from "../../../shared/action-parameters";
import type { BroadcastFn, DispatchAgentChatFn } from "./dispatch-types";

export const dispatchToAgentAction: Action = {
  name: "DISPATCH_TO_AGENT",
  description:
    "Execute a command on the user's behalf by dispatching to a specific agent in their team. Use when the user wants to trade, post, comment, or take any agent action. Do NOT use for information queries — use CHECK_PERPS, CHECK_PREDICTIONS etc. for those.",

  parameters: defineActionParameters({
    agentId: {
      type: "string",
      required: true,
      description:
        "The ID of the agent to dispatch to — use the [id: ...] shown in the Team Members list",
    },
    command: {
      type: "string",
      required: true,
      description:
        'The exact instruction to send to the agent (e.g., "open a 2x long on TSLAI for $100", "post about the current market")',
    },
  }),

  examples: [
    [
      {
        name: "user",
        content: { text: "Open a long position on TSLAI with $100" },
      },
      {
        name: "coordinator",
        content: {
          text: "I'll dispatch that trade to your trading agent.",
        },
      },
    ],
    [
      {
        name: "user",
        content: { text: "Make my agent post about the NVDAI rally" },
      },
      {
        name: "coordinator",
        content: {
          text: "I'll send that posting instruction to your agent now.",
        },
      },
    ],
  ],

  // Only expose this action when the team actually has agents to dispatch to
  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
  ): Promise<boolean> => {
    interface TeamMember {
      isAgent: boolean;
    }
    const members =
      (state?.data?.teamMembers as TeamMember[] | undefined) ?? [];
    return members.some((m) => m.isAgent);
  },

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const actionParams = state?.data?.actionParams as
      | { agentId?: string; command?: string }
      | undefined;

    // broadcastFn is injected by the coordinator route into state.data
    const broadcastFn = state?.data?.broadcastFn as BroadcastFn | undefined;
    const dispatchAgentChat = state?.data?.dispatchAgentChat as
      | DispatchAgentChatFn
      | undefined;

    const agentId = actionParams?.agentId;
    const command = actionParams?.command;
    const ownerId = state?.values?.ownerId as string | undefined;
    const teamChatId = state?.values?.teamChatId as string | undefined;
    const ownerName = state?.values?.ownerName as string | undefined;
    const ownerUsername = state?.values?.ownerUsername as string | undefined;

    if (
      !agentId ||
      !command ||
      !ownerId ||
      !teamChatId ||
      !broadcastFn ||
      !dispatchAgentChat
    ) {
      const failResult: ActionResult = {
        success: false,
        text: "Missing required parameters for agent dispatch.",
      };
      _callback?.({ text: failResult.text });
      return failResult;
    }

    const result = await dispatchAgentChat({
      agentId,
      ownerId,
      message: command,
      teamChatId,
      ownerName,
      ownerUsername,
      broadcastFn,
    });

    if (!result.success) {
      // Include available agent info so the coordinator's next iteration can retry
      // with the correct agent ID instead of giving up.
      const failResult = {
        success: false,
        text: `Failed to dispatch to agent "${agentId}": ${result.error ?? "Unknown error"}. Check the Team Members list for the correct agent [id: ...] and retry.`,
        values: { agentId, command, error: result.error },
      };
      _callback?.({ text: failResult.text, agentId, command });
      return failResult;
    }

    const successResult = {
      success: true,
      text: `Dispatched to @${result.agentUsername ?? agentId}: "${result.response.slice(0, 300)}"`,
      values: {
        agentId: result.agentId,
        agentUsername: result.agentUsername,
        dispatchedCommand: command,
        agentResponse: result.response,
        actionsExecuted: result.actionsExecuted,
      },
    };
    _callback?.({
      text: successResult.text,
      agentId: result.agentId,
      agentUsername: result.agentUsername,
      dispatchedCommand: command,
      actionsExecuted: result.actionsExecuted,
    });
    return successResult;
  },
};
