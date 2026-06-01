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
  recentContext: GoalWorkstreamContextMessage[];
}

export interface GoalWorkstreamContextMessage {
  role: string;
  text: string;
  timestamp?: number;
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

function normalizeContextMessages(
  value: unknown,
): GoalWorkstreamContextMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const record = metadataRecord(entry);
      if (!record) return null;
      const text = stringValue(record.text);
      if (!text) return null;
      const role = stringValue(record.role) ?? "context";
      const timestamp =
        typeof record.timestamp === "number" &&
        Number.isFinite(record.timestamp)
          ? record.timestamp
          : undefined;
      return {
        role,
        text: text.slice(0, 1000),
        ...(timestamp !== undefined ? { timestamp } : {}),
      };
    })
    .filter((entry): entry is GoalWorkstreamContextMessage => entry !== null)
    .slice(-12);
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
  const recentContext = normalizeContextMessages(requested.recentContext);
  return {
    enabled,
    autoSpawnAgent: booleanValue(requested.autoSpawnAgent) ?? true,
    framework: stringValue(requested.framework) ?? "codex",
    label: stringValue(requested.label) ?? "GoalScout",
    recentContext,
    ...(roomId ? { roomId } : {}),
    ...(workdir ? { workdir } : {}),
  };
}

function formatContextMessage(
  message: GoalWorkstreamContextMessage,
  index: number,
): string {
  const role = message.role.replace(/\s+/g, " ").trim() || "context";
  const text = message.text.replace(/\s+/g, " ").trim();
  return `${index + 1}. ${role}: ${text}`;
}

function formatRecentContext(
  messages: readonly GoalWorkstreamContextMessage[],
): string | null {
  if (messages.length === 0) return null;
  return [
    "Recent chat context:",
    ...messages.map((message, index) => formatContextMessage(message, index)),
  ].join("\n");
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
    formatRecentContext(workstream?.recentContext ?? []),
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
      sourceContextMessageCount: workstream?.recentContext.length ?? 0,
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
    "Return a LifeOps action brief, not a generic inspection plan.",
    "Output exactly these sections:",
    "1. Next action: one concrete action the owner or agent should take now.",
    "2. Why now: one sentence grounded in the recent context above.",
    "3. Blockers: list any missing information or say None.",
    "4. Follow-up: one short check-in or subtask to keep this goal moving.",
    "",
    "Use the recent chat context when present. If workspace inspection is useful but unavailable, do not lead with that; still produce the best next action from the goal/context.",
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
