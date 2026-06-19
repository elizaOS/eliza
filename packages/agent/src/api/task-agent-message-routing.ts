import type { AgentRuntime, UUID } from "@elizaos/core";

export interface TaskAgentChatRouting {
  sessionId?: string;
  threadId?: string;
  roomId?: string | null;
}

interface TaskAgentRoutingTaskContext {
  label?: string;
  sessionId?: string;
  threadId?: string;
}

interface TaskAgentRoutingCoordinator {
  getTaskContext?: (
    sessionId: string,
  ) => { threadId?: string | null } | null | undefined;
  getAllTaskContexts?: () => TaskAgentRoutingTaskContext[];
  getTaskThread?: (
    threadId: string,
  ) => Promise<{ roomId?: string | null } | null>;
}

type RoutingRuntime = Pick<
  AgentRuntime,
  "getRoom" | "getService" | "sendMessageToTarget"
>;

function getRoutingCoordinator(
  runtime: RoutingRuntime,
): TaskAgentRoutingCoordinator | null {
  const coordinator = runtime.getService("SWARM_COORDINATOR");
  return coordinator && typeof coordinator === "object"
    ? (coordinator as TaskAgentRoutingCoordinator)
    : null;
}

function inferTaskAgentRoutingFromMessage(
  text: string,
  coordinator: TaskAgentRoutingCoordinator | null,
): TaskAgentChatRouting | undefined {
  const taskContexts = coordinator?.getAllTaskContexts?.();
  if (!Array.isArray(taskContexts) || taskContexts.length === 0) {
    return undefined;
  }

  const loginLabelMatch = text.match(/^"([^"]+)" needs a provider login\b/);
  const matchingTask = loginLabelMatch?.[1]
    ? taskContexts.filter((task) => task.label === loginLabelMatch[1])
    : taskContexts.length === 1
      ? taskContexts
      : [];

  if (matchingTask.length !== 1) {
    return undefined;
  }

  const [taskContext] = matchingTask;
  return {
    ...(taskContext.sessionId ? { sessionId: taskContext.sessionId } : {}),
    ...(taskContext.threadId ? { threadId: taskContext.threadId } : {}),
  };
}

export async function routeTaskAgentTextToConnector(
  runtime: RoutingRuntime | null,
  text: string,
  source: string,
  routing?: TaskAgentChatRouting,
): Promise<boolean> {
  if (!runtime) return false;

  const coordinator = getRoutingCoordinator(runtime);
  const resolvedRouting = {
    ...(routing ?? inferTaskAgentRoutingFromMessage(text, coordinator)),
  } satisfies TaskAgentChatRouting;

  if (!resolvedRouting.threadId && resolvedRouting.sessionId) {
    const taskContext = coordinator?.getTaskContext?.(
      resolvedRouting.sessionId,
    );
    if (taskContext?.threadId) {
      resolvedRouting.threadId = taskContext.threadId;
    }
  }

  let roomId = resolvedRouting.roomId ?? null;
  if (!roomId && resolvedRouting.threadId) {
    const thread = await coordinator?.getTaskThread?.(resolvedRouting.threadId);
    roomId =
      thread &&
      typeof thread.roomId === "string" &&
      thread.roomId.trim().length > 0
        ? thread.roomId
        : null;
  }
  if (!roomId) return false;

  const room = await runtime.getRoom(roomId as UUID).catch(() => null);
  if (!room?.source) return false;

  await runtime.sendMessageToTarget(
    {
      source: room.source,
      roomId: room.id,
      channelId: room.channelId ?? room.id,
      serverId: room.serverId ?? undefined,
    } as Parameters<RoutingRuntime["sendMessageToTarget"]>[0],
    { text, source },
  );
  return true;
}
