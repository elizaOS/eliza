import type { LifeOpsGoalDefinition } from "../contracts/index.js";

export const ORCHESTRATOR_TASK_SERVICE_TYPE = "ORCHESTRATOR_TASK_SERVICE";

export type GoalWorkstreamStatus =
  | "requested"
  | "unavailable"
  | "task_created"
  | "active"
  | "failed";

export interface GoalWorkstreamConfig {
  enabled: boolean;
  autoSpawnAgent: boolean;
  framework: string;
  label: string;
  roomId?: string;
  workdir?: string;
}

export interface OrchestratorTaskDetailLike {
  id: string;
  latestSessionId?: string | null;
  latestSessionLabel?: string | null;
  sessions?: Array<{
    sessionId?: string | null;
    label?: string | null;
    status?: string | null;
  }>;
}

export interface OrchestratorTaskServiceLike {
  createTask(input: {
    title: string;
    goal: string;
    originalRequest?: string;
    kind?: string;
    priority?: "low" | "normal" | "high" | "urgent";
    acceptanceCriteria?: string[];
    roomId?: string;
    taskRoomId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<OrchestratorTaskDetailLike>;
  spawnAgentForTask(
    taskId: string,
    opts?: {
      framework?: string;
      label?: string;
      task?: string;
      workdir?: string;
    },
  ): Promise<OrchestratorTaskDetailLike | null>;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function metadataRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readGoalWorkstreamConfig(
  metadata: Record<string, unknown>,
): GoalWorkstreamConfig | null {
  const requested = metadataRecord(metadata.lifeopsGoalWorkstream);
  if (!requested) return null;
  const enabled = booleanValue(requested.enabled) ?? true;
  if (!enabled) return null;
  const roomId = stringValue(requested.roomId);
  const workdir = stringValue(requested.workdir);
  return {
    enabled,
    autoSpawnAgent: booleanValue(requested.autoSpawnAgent) ?? true,
    framework: stringValue(requested.framework) ?? "codex",
    label: stringValue(requested.label) ?? "GoalScout",
    ...(roomId ? { roomId } : {}),
    ...(workdir ? { workdir } : {}),
  };
}

export function buildLifeOpsGoalWorkstreamTaskInput(
  goal: LifeOpsGoalDefinition,
): {
  title: string;
  goal: string;
  originalRequest: string;
  kind: string;
  priority: "normal";
  acceptanceCriteria: string[];
  roomId?: string;
  taskRoomId?: string;
  metadata: Record<string, unknown>;
} {
  const style = metadataRecord(goal.metadata.lifeopsGoalStyle);
  const workstream = readGoalWorkstreamConfig(goal.metadata);
  const styleLabel = stringValue(style?.label);
  const promptHints = Array.isArray(style?.promptHints)
    ? style.promptHints.filter(
        (hint): hint is string =>
          typeof hint === "string" && hint.trim().length > 0,
      )
    : [];
  const description = goal.description.trim();
  const goalText = [
    `Keep momentum on LifeOps goal: ${goal.title}`,
    description ? `Description: ${description}` : null,
    styleLabel ? `Goal style: ${styleLabel}` : null,
    promptHints.length > 0 ? `Hints: ${promptHints.join(" ")}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  return {
    title: `LifeOps: ${goal.title}`,
    goal: goalText,
    originalRequest: `LifeOps goal created from ${stringValue(goal.metadata.command) ?? "goal creation"}.`,
    kind: "lifeops_goal",
    priority: "normal",
    acceptanceCriteria: [
      "Keep the goal moving with one concrete next action.",
      "Preserve private LifeOps context; do not publish or push anything.",
      "Report blockers as task messages instead of silently failing.",
    ],
    ...(workstream?.roomId
      ? {
          roomId: workstream.roomId,
          taskRoomId: workstream.roomId,
        }
      : {}),
    metadata: {
      source: "lifeops_goal",
      lifeopsGoalId: goal.id,
      ...(workstream?.roomId ? { sourceRoomId: workstream.roomId } : {}),
      ...(workstream?.workdir ? { sourceWorkdir: workstream.workdir } : {}),
      ...(style ? { lifeopsGoalStyle: style } : {}),
      privacyClass: "private",
      publicContextBlocked: true,
    },
  };
}

export function buildLifeOpsGoalInitialAgentTask(
  goal: LifeOpsGoalDefinition,
): string {
  const input = buildLifeOpsGoalWorkstreamTaskInput(goal);
  return [
    input.goal,
    "",
    "Briefly inspect available context, then return the next useful action for this LifeOps goal.",
    "Do not commit, push, or open pull requests unless the user explicitly asks.",
  ].join("\n");
}

export function getLatestSession(detail: OrchestratorTaskDetailLike | null): {
  sessionId?: string;
  label?: string;
} {
  if (!detail) return {};
  const latest = detail.sessions?.at(-1);
  return {
    sessionId:
      stringValue(detail.latestSessionId) ?? stringValue(latest?.sessionId),
    label: stringValue(detail.latestSessionLabel) ?? stringValue(latest?.label),
  };
}
