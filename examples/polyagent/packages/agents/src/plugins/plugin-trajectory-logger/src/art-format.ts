/**
 * ART Format Conversion
 *
 * Converts our rich trajectory format to ART-compatible format.
 *
 * Key insight from ART examples:
 * - Trajectories are MESSAGE ARRAYS (system/user/assistant)
 * - Metadata is separate (for RULER context)
 * - Single reward per trajectory
 * - Grouping by scenario for GRPO
 */

import type { JsonValue } from "@polyagent/shared";
import type {
  ARTTrajectory,
  ChatMessage,
  Trajectory,
  TrajectoryGroup,
  TrajectoryStep,
} from "./types";

/**
 * Convert rich trajectory to ART message format
 *
 * Extracts OpenAGI-style message array from our step-based trajectory.
 * This is what ART/GRPO actually trains on.
 */
export function toARTMessages(trajectory: Trajectory): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // Add system message (agent identity/goal)
  const systemMessage = buildSystemMessage(trajectory);
  if (systemMessage) {
    messages.push(systemMessage);
  }

  // Extract messages from steps
  for (const step of trajectory.steps) {
    // Each step represents a user prompt (observation) + assistant response (action)

    // 1. USER message: Environment observation + context
    const userContent = buildUserMessage(step);
    if (userContent) {
      messages.push({
        role: "user",
        content: userContent,
      });
    }

    // 2. ASSISTANT message: Agent's decision/action
    const assistantContent = buildAssistantMessage(step);
    if (assistantContent) {
      messages.push({
        role: "assistant",
        content: assistantContent,
      });
    }
  }

  return messages;
}

/**
 * Build system message from trajectory
 */
function buildSystemMessage(trajectory: Trajectory): ChatMessage | null {
  // Use agent's system prompt if available in first LLM call
  const firstStep = trajectory.steps[0];
  const firstLLMCall = firstStep?.llmCalls?.[0];

  if (firstLLMCall?.systemPrompt) {
    return {
      role: "system",
      content: firstLLMCall.systemPrompt,
    };
  }

  // Fallback: construct from metadata
  const agentName = trajectory.metadata.agentName || "Agent";
  const goal = trajectory.metadata.goalDescription || "make good decisions";

  return {
    role: "system",
    content: `You are ${agentName}, an autonomous agent. Your goal is to ${goal}.`,
  };
}

/**
 * Build user message from step (environment observation)
 */
function buildUserMessage(step: TrajectoryStep): string | null {
  // Use the actual user prompt from LLM calls
  const llmCall = step.llmCalls.find((call) => call.purpose === "action");

  if (llmCall?.userPrompt) {
    return llmCall.userPrompt;
  }

  // Fallback: construct from environment state + provider data
  const parts: string[] = [];

  // Add environment state
  parts.push(`Current state:`);
  parts.push(`- Balance: $${step.environmentState.agentBalance}`);
  parts.push(`- P&L: $${step.environmentState.agentPnL}`);
  parts.push(`- Open Positions: ${step.environmentState.openPositions}`);

  // Add provider data
  for (const provider of step.providerAccesses) {
    parts.push(`\n${provider.providerName} data:`);
    parts.push(JSON.stringify(provider.data, null, 2));
  }

  parts.push(`\nWhat action should you take?`);

  return parts.join("\n");
}

/**
 * Build assistant message from step (agent's action/decision)
 */
function buildAssistantMessage(step: TrajectoryStep): string | null {
  // Use the actual LLM response
  const llmCall = step.llmCalls.find((call) => call.purpose === "action");

  if (llmCall?.response) {
    return llmCall.response;
  }

  // Fallback: construct from action
  const action = step.action;
  const parts: string[] = [];

  parts.push(`I will ${action.actionType}.`);

  if (action.reasoning) {
    parts.push(`Reasoning: ${action.reasoning}`);
  }

  parts.push(`Parameters: ${JSON.stringify(action.parameters)}`);

  return parts.join("\n");
}

/**
 * Convert rich trajectory to ART format
 *
 * This is the format ART expects for training.
 */
export function toARTTrajectory(trajectory: Trajectory): ARTTrajectory {
  return {
    messages: toARTMessages(trajectory),
    reward: trajectory.totalReward,
    metadata: {
      trajectoryId: trajectory.trajectoryId,
      agentId: trajectory.agentId,
      scenarioId: trajectory.scenarioId,
      groupIndex: trajectory.groupIndex,

      // Environment context for RULER
      environmentContext: {
        initialBalance: trajectory.steps[0]?.environmentState.agentBalance || 0,
        finalBalance: trajectory.metrics.finalBalance || 0,
        initialPnL: trajectory.steps[0]?.environmentState.agentPnL || 0,
        finalPnL: trajectory.metrics.finalPnL || 0,
        actionsTaken: trajectory.steps.map((s) => s.action.actionType),
        errors: trajectory.steps
          .filter((s) => !s.action.success)
          .map((s) => s.action.error || "Unknown error"),
      },

      // Game knowledge for RULER (you know the future!)
      gameKnowledge: extractGameKnowledge(trajectory),

      // Performance metrics for RULER
      metrics: JSON.parse(JSON.stringify(trajectory.metrics)) as Record<
        string,
        JsonValue
      >,
    },
    metrics: filterNumericMetrics(trajectory.metrics),
  };
}

/**
 * Filter metrics to only include numeric values
 * Converts trajectory.metrics (which may have unknown values) to Record<string, number>
 */
function filterNumericMetrics(
  metrics: Trajectory["metrics"],
): Record<string, number> {
  const numericMetrics: Record<string, number> = {};

  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "number" && !Number.isNaN(value)) {
      numericMetrics[key] = value;
    }
  }

  return numericMetrics;
}

/**
 * Extract game knowledge from trajectory metadata
 */
function extractGameKnowledge(trajectory: Trajectory): {
  trueProbabilities?: Record<string, number>;
  actualOutcomes?: Record<string, JsonValue>;
  hiddenVariables?: Record<string, JsonValue>;
  gameEvents?: JsonValue[];
} {
  const knowledge: {
    trueProbabilities?: Record<string, number>;
    actualOutcomes?: Record<string, JsonValue>;
    hiddenVariables?: Record<string, JsonValue>;
    gameEvents?: JsonValue[];
  } = {};

  // Extract from metadata if available
  if (trajectory.metadata.trueProbabilities) {
    knowledge.trueProbabilities = trajectory.metadata
      .trueProbabilities as Record<string, number>;
  }

  if (trajectory.metadata.futureOutcomes) {
    knowledge.actualOutcomes = trajectory.metadata.futureOutcomes as Record<
      string,
      JsonValue
    >;
  }

  if (trajectory.metadata.hiddenVariables) {
    knowledge.hiddenVariables = trajectory.metadata.hiddenVariables as Record<
      string,
      JsonValue
    >;
  }

  // Extract from steps (game events)
  const gameEvents = trajectory.steps
    .map((s) => s.metadata?.gameEvent)
    .filter((e): e is JsonValue => !!e);

  if (gameEvents.length > 0) {
    knowledge.gameEvents = gameEvents;
  }

  return knowledge;
}

/**
 * Group trajectories by scenario for GRPO
 *
 * Takes multiple trajectories and groups them by scenarioId.
 * This is what RULER needs to compare trajectories.
 */
export function groupTrajectories(
  trajectories: Trajectory[],
): TrajectoryGroup[] {
  const groups = new Map<string, Trajectory[]>();

  for (const traj of trajectories) {
    const scenarioId = traj.scenarioId || "default";
    if (!groups.has(scenarioId)) {
      groups.set(scenarioId, []);
    }
    groups.get(scenarioId)?.push(traj);
  }

  return Array.from(groups.entries()).map(([scenarioId, trajs], idx) => ({
    groupId: `group-${idx}`,
    scenarioId,
    trajectories: trajs,
    sharedPrefix: extractSharedPrefix(trajs),
    createdAt: Date.now(),
  }));
}

/**
 * Extract shared prefix from multiple trajectories
 *
 * RULER deduplicates common message prefixes.
 * This saves tokens when judging.
 */
export function extractSharedPrefix(trajectories: Trajectory[]): ChatMessage[] {
  if (trajectories.length === 0) return [];

  const allMessages = trajectories.map((t) => toARTMessages(t));
  if (allMessages.length === 0) return [];

  const firstMessages = allMessages[0]!;
  const sharedPrefix: ChatMessage[] = [];

  // Find messages that are identical across all trajectories
  for (let i = 0; i < firstMessages.length; i++) {
    const message = firstMessages[i]!;
    const allMatch = allMessages.every(
      (msgs) =>
        msgs[i] &&
        msgs[i]?.role === message.role &&
        msgs[i]?.content === message.content,
    );

    if (allMatch) {
      sharedPrefix.push(message);
    } else {
      break; // Stop at first difference
    }
  }

  return sharedPrefix;
}

/**
 * Remove shared prefix from messages
 *
 * Returns the unique suffix for each trajectory.
 */
export function removeSharedPrefix(
  messages: ChatMessage[],
  sharedPrefix: ChatMessage[],
): ChatMessage[] {
  return messages.slice(sharedPrefix.length);
}

/**
 * Prepare trajectories for RULER ranking
 *
 * Formats trajectory group for LLM-as-judge to rank.
 */
export function prepareForRULER(group: TrajectoryGroup): {
  sharedPrefix: ChatMessage[];
  suffixes: ChatMessage[][];
  metadata: ARTTrajectory["metadata"][];
} {
  const artTrajs = group.trajectories.map((t) => toARTTrajectory(t));
  const sharedPrefix =
    group.sharedPrefix || extractSharedPrefix(group.trajectories);

  return {
    sharedPrefix,
    suffixes: artTrajs.map((art) =>
      removeSharedPrefix(art.messages, sharedPrefix),
    ),
    metadata: artTrajs.map((art) => art.metadata),
  };
}

/**
 * Convert trajectory to ART-compatible JSONL line
 */
export function toARTJSONL(trajectory: Trajectory): string {
  const artTraj = toARTTrajectory(trajectory);
  return JSON.stringify(artTraj);
}

/**
 * Validate trajectory can be converted to ART format
 */
export function validateARTCompatibility(trajectory: Trajectory): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Must have steps
  if (trajectory.steps.length === 0) {
    errors.push("Trajectory has no steps");
  }

  // Each step must have at least one LLM call
  for (const [idx, step] of trajectory.steps.entries()) {
    if (step.llmCalls.length === 0) {
      errors.push(`Step ${idx} has no LLM calls - can't extract messages`);
    }

    for (const llmCall of step.llmCalls) {
      if (!llmCall.userPrompt || llmCall.userPrompt.length < 10) {
        warnings.push(`Step ${idx} has very short user prompt`);
      }
      if (!llmCall.response || llmCall.response.length < 5) {
        warnings.push(`Step ${idx} has very short response`);
      }
    }
  }

  // Must have reward
  if (
    trajectory.totalReward === undefined ||
    Number.isNaN(trajectory.totalReward)
  ) {
    errors.push("Trajectory has no valid reward");
  }

  // Try to convert
  const artTraj = toARTTrajectory(trajectory);
  if (artTraj.messages.length < 2) {
    warnings.push("Trajectory converts to very few messages (< 2)");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
