/**
 * RELAY_TO_AGENT Action (Context-Enriched Dispatch)
 *
 * Dispatches a command to an agent with structured context from previous
 * agent responses. This enables multi-agent workflows where one agent's
 * output informs another agent's task.
 *
 * Example flow:
 * 1. Coordinator dispatches to Agent A (research): "What's trending?"
 * 2. Agent A responds with research findings
 * 3. Coordinator relays to Agent B (trading): "Based on research: [Agent A's findings],
 *    execute the best trade opportunity"
 *
 * The relayContext is prepended to the command so the target agent sees it
 * as additional context in its system prompt.
 */

import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import {
  type BroadcastFn,
  dispatchAgentChat,
} from '../../../../services/AgentChatService';

export const relayToAgentAction: Action = {
  name: 'RELAY_TO_AGENT',
  description:
    'Dispatch to an agent with context from previous agent responses. Use after gathering information from other agents to pass their findings to an execution agent.',

  // Cast needed: alpha elizaos expects ActionParameter[] (protobuf array).
  parameters: {
    agentId: {
      type: 'string',
      required: true,
      description:
        'The ID of the target agent — use the [id: ...] shown in Team Members',
    },
    command: {
      type: 'string',
      required: true,
      description: 'The instruction for the target agent',
    },
    relayContext: {
      type: 'string',
      required: true,
      description:
        'Structured context from other agents to pass along (e.g., "Agent A found: X, Agent B found: Y")',
    },
  } as unknown as Action['parameters'],

  examples: [
    [
      {
        name: 'user',
        content: {
          text: 'Have my research agent analyze trends, then my trader execute on it',
        },
      },
      {
        name: 'coordinator',
        content: {
          text: "I'll relay the research findings to your trading agent for execution.",
        },
      },
    ],
  ],

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    state?: State
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
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const actionParams = state?.data?.actionParams as
      | { agentId?: string; command?: string; relayContext?: string }
      | undefined;

    const broadcastFn = state?.data?.broadcastFn as BroadcastFn | undefined;
    const ownerId = state?.values?.ownerId as string | undefined;
    const teamChatId = state?.values?.teamChatId as string | undefined;
    const ownerName = state?.values?.ownerName as string | undefined;
    const ownerUsername = state?.values?.ownerUsername as string | undefined;

    const agentId = actionParams?.agentId;
    const command = actionParams?.command;
    const relayContext = actionParams?.relayContext;

    if (!agentId || !command || !ownerId || !teamChatId || !broadcastFn) {
      const failResult = {
        success: false,
        text: 'Missing required parameters for relay dispatch.',
      };
      _callback?.({ content: failResult as unknown as Content });
      return failResult as unknown as ActionResult;
    }

    // Build enriched command with relay context prepended
    const enrichedCommand = relayContext
      ? `--- Context from other agents ---\n${relayContext}\n--- End context ---\n\nYour task: ${command}`
      : command;

    const result = await dispatchAgentChat({
      agentId,
      ownerId,
      message: enrichedCommand,
      teamChatId,
      ownerName,
      ownerUsername,
      broadcastFn,
    });

    if (!result.success) {
      const failResult = {
        success: false,
        text: `Failed to relay to agent: ${result.error ?? 'Unknown error'}`,
        values: { agentId, command, relayContext, error: result.error },
      };
      _callback?.({ content: failResult as unknown as Content });
      return failResult as unknown as ActionResult;
    }

    const successResult = {
      success: true,
      text: `Relayed to @${result.agentUsername ?? agentId} (with context from other agents): "${result.response.slice(0, 300)}"`,
      values: {
        agentId: result.agentId,
        agentUsername: result.agentUsername,
        dispatchedCommand: command,
        relayContext,
        agentResponse: result.response,
        actionsExecuted: result.actionsExecuted,
      },
    } as unknown as ActionResult;
    _callback?.({ content: successResult as unknown as Content });
    return successResult;
  },
};
