import type { Memory, State } from "@elizaos/core";
import type { SwarmCoordinator } from "../services/swarm-coordinator.js";
import type {
  ListTaskThreadsOptions,
  TaskThreadSummary,
} from "../services/task-registry.js";

type MessageFields = {
  roomId?: string;
  userId?: string;
  content?: Record<string, unknown>;
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function inferSearchText(text: string): string | undefined {
  const quoted =
    text.match(/"([^"]{3,120})"/)?.[1] ?? text.match(/'([^']{3,120})'/)?.[1];
  if (quoted) return quoted.trim();

  const topical =
    text.match(/\bworking on\s+(.+?)(?:[?.!,]|$)/i)?.[1] ??
    text.match(/\bfor\s+(.+?)(?:[?.!,]|$)/i)?.[1] ??
    text.match(/\bon\s+(.+?)(?:[?.!,]|$)/i)?.[1];
  return topical?.trim();
}

function buildScopedListOptions(
  message: Memory,
  includeArchived: boolean,
): ListTaskThreadsOptions {
  const messageLike = message as MessageFields;
  return {
    includeArchived,
    roomId: stringValue(messageLike.roomId),
    ownerUserId: stringValue(messageLike.userId),
    limit: 10,
  };
}

async function threadBySession(
  coordinator: SwarmCoordinator,
  sessionId: string,
): Promise<TaskThreadSummary | null> {
  const threadId =
    await coordinator.taskRegistry.findThreadIdBySessionId(sessionId);
  if (!threadId) return null;
  const detail = await coordinator.getTaskThread(threadId);
  return detail;
}

export async function resolveTaskThreadTarget(params: {
  coordinator: SwarmCoordinator;
  message: Memory;
  state?: State;
  options?: Record<string, unknown>;
  includeArchived?: boolean;
}): Promise<TaskThreadSummary | null> {
  const {
    coordinator,
    message,
    state,
    options,
    includeArchived = true,
  } = params;
  const content = (message.content ?? {}) as Record<string, unknown>;

  const explicitThreadId =
    stringValue(options?.threadId) ?? stringValue(content.threadId);
  if (explicitThreadId) {
    return coordinator.getTaskThread(explicitThreadId);
  }

  const codingSession =
    state && typeof state === "object"
      ? ((state as Record<string, unknown>).codingSession as
          | Record<string, unknown>
          | undefined)
      : undefined;
  const explicitSessionId =
    stringValue(options?.sessionId) ??
    stringValue(content.sessionId) ??
    stringValue(codingSession?.id);
  if (explicitSessionId) {
    const bySession = await threadBySession(coordinator, explicitSessionId);
    if (bySession) return bySession;
  }

  const search =
    stringValue(options?.search) ??
    stringValue(content.search) ??
    inferSearchText(typeof content.text === "string" ? content.text : "");
  if (search) {
    const matches = await coordinator.listTaskThreads({
      ...buildScopedListOptions(message, includeArchived),
      search,
    });
    if (matches.length > 0) return matches[0];
  }

  const scoped = await coordinator.listTaskThreads(
    buildScopedListOptions(message, includeArchived),
  );
  if (scoped.length > 0) return scoped[0];

  const recent = await coordinator.listTaskThreads({
    includeArchived,
    limit: 10,
  });
  return recent[0] ?? null;
}
