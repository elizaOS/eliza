/**
 * ART Format Conversion
 *
 * Converts our rich trajectory format to ART-compatible format.
 *
 * Key insight from ART examples:
 * - Trajectories are MESSAGE ARRAYS (system/user/assistant)
 * - Metadata is separate (for judge context)
 * - Single reward per trajectory
 * - Grouping by scenario for GRPO
 */

import type {
  ARTTrajectory,
  ChatMessage,
  JsonValue,
  Trajectory,
  TrajectoryGroup,
  TrajectoryStep,
} from "./types";

/**
 * Convert rich trajectory to ART message format.
 */
export function toARTMessages(trajectory: Trajectory): ChatMessage[] {
  const messages: ChatMessage[] = [];

  const systemMessage = buildSystemMessage(trajectory);
  if (systemMessage) {
    messages.push(systemMessage);
  }

  for (const step of trajectory.steps) {
    const userContent = buildUserMessage(step);
    if (userContent) {
      messages.push({ role: "user", content: userContent });
    }

    const assistantContent = buildAssistantMessage(step);
    if (assistantContent) {
      messages.push({ role: "assistant", content: assistantContent });
    }
  }

  return messages;
}

function buildSystemMessage(trajectory: Trajectory): ChatMessage | null {
  const firstStep = trajectory.steps[0];
  const firstLLMCall = firstStep?.llmCalls?.[0];

  if (firstLLMCall?.systemPrompt) {
    return { role: "system", content: firstLLMCall.systemPrompt };
  }

  const agentName = trajectory.metadata.agentName || "Agent";
  const goal = trajectory.metadata.goalDescription || "make good decisions";

  return {
    role: "system",
    content: `You are ${agentName}, an autonomous agent. Your goal is to ${goal}.`,
  };
}

function buildUserMessage(step: TrajectoryStep): string | null {
  const llmCall = step.llmCalls.find((call) => call.purpose === "action");
  if (llmCall?.userPrompt) {
    return llmCall.userPrompt;
  }

  const parts: string[] = [];
  parts.push("Current state:");
  parts.push(`- Balance: $${step.environmentState.agentBalance}`);
  parts.push(`- P&L: $${step.environmentState.agentPnL}`);
  parts.push(`- Open Positions: ${step.environmentState.openPositions}`);

  for (const provider of step.providerAccesses) {
    parts.push(`\n${provider.providerName} data:`);
    parts.push(JSON.stringify(provider.data, null, 2));
  }

  parts.push("\nWhat action should you take?");
  return parts.join("\n");
}

function buildAssistantMessage(step: TrajectoryStep): string | null {
  const llmCall = step.llmCalls.find((call) => call.purpose === "action");
  if (llmCall?.response) {
    return llmCall.response;
  }

  const action = step.action;
  const parts: string[] = [];

  parts.push(`I will ${action.actionType}.`);
  if (action.reasoning) {
    parts.push(`Reasoning: ${action.reasoning}`);
  }
  parts.push(`Parameters: ${JSON.stringify(action.parameters)}`);

  return parts.join("\n");
}

export function toARTTrajectory(trajectory: Trajectory): ARTTrajectory {
  return {
    messages: toARTMessages(trajectory),
    reward: trajectory.totalReward,
    metadata: {
      trajectoryId: trajectory.trajectoryId,
      agentId: trajectory.agentId,
      scenarioId: trajectory.scenarioId,
      groupIndex: trajectory.groupIndex,
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
      gameKnowledge: extractGameKnowledge(trajectory),
      metrics: JSON.parse(JSON.stringify(trajectory.metrics)) as Record<string, JsonValue>,
    },
    metrics: filterNumericMetrics(trajectory.metrics),
  };
}

function filterNumericMetrics(metrics: Trajectory["metrics"]): Record<string, number> {
  const numericMetrics: Record<string, number> = {};

  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "number" && !Number.isNaN(value)) {
      numericMetrics[key] = value;
    }
  }

  return numericMetrics;
}

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

  if (trajectory.metadata.trueProbabilities) {
    knowledge.trueProbabilities = trajectory.metadata.trueProbabilities as Record<string, number>;
  }

  if (trajectory.metadata.futureOutcomes) {
    knowledge.actualOutcomes = trajectory.metadata.futureOutcomes as Record<string, JsonValue>;
  }

  if (trajectory.metadata.hiddenVariables) {
    knowledge.hiddenVariables = trajectory.metadata.hiddenVariables as Record<string, JsonValue>;
  }

  const gameEvents = trajectory.steps
    .map((s) => s.metadata?.gameEvent)
    .filter((e): e is JsonValue => !!e);

  if (gameEvents.length > 0) {
    knowledge.gameEvents = gameEvents;
  }

  return knowledge;
}

export function groupTrajectories(trajectories: Trajectory[]): TrajectoryGroup[] {
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

export function extractSharedPrefix(trajectories: Trajectory[]): ChatMessage[] {
  if (trajectories.length === 0) return [];

  const allMessages = trajectories.map((t) => toARTMessages(t));
  if (allMessages.length === 0) return [];

  const firstMessages = allMessages[0];
  if (!firstMessages) return [];
  const sharedPrefix: ChatMessage[] = [];

  for (let i = 0; i < firstMessages.length; i++) {
    const message = firstMessages[i];
    if (!message) break;
    const allMatch = allMessages.every(
      (msgs) => msgs[i] && msgs[i]?.role === message.role && msgs[i]?.content === message.content
    );

    if (allMatch) {
      sharedPrefix.push(message);
    } else {
      break;
    }
  }

  return sharedPrefix;
}

export function removeSharedPrefix(
  messages: ChatMessage[],
  sharedPrefix: ChatMessage[]
): ChatMessage[] {
  return messages.slice(sharedPrefix.length);
}

export function prepareForRULER(group: TrajectoryGroup): {
  sharedPrefix: ChatMessage[];
  suffixes: ChatMessage[][];
  metadata: ARTTrajectory["metadata"][];
} {
  const artTrajs = group.trajectories.map((t) => toARTTrajectory(t));
  const sharedPrefix = group.sharedPrefix || extractSharedPrefix(group.trajectories);

  return {
    sharedPrefix,
    suffixes: artTrajs.map((art) => removeSharedPrefix(art.messages, sharedPrefix)),
    metadata: artTrajs.map((art) => art.metadata),
  };
}

export function toARTJSONL(trajectory: Trajectory): string {
  return JSON.stringify(toARTTrajectory(trajectory));
}

export function validateARTCompatibility(trajectory: Trajectory): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (trajectory.steps.length === 0) {
    errors.push("Trajectory has no steps");
  }

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

  if (trajectory.totalReward === undefined || Number.isNaN(trajectory.totalReward)) {
    errors.push("Trajectory has no valid reward");
  }

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
