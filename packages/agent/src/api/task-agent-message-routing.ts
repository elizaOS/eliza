/**
 * Routes task-agent chat text back to the connector the task originated on.
 * Resolves the swarm coordinator's task context — session id to thread to room —
 * from explicit routing hints, or failing that by matching a `"<label>" needs a
 * provider login` message (or a single in-flight task), then delivers the text
 * through `runtime.sendMessageToTarget` on the resolved room's source connector.
 * Returns false when no room can be resolved.
 */
import {
  type AgentRuntime,
  getSwarmCoordinatorService,
  type ISwarmCoordinatorService,
  type UUID,
} from "@elizaos/core";

export interface TaskAgentChatRouting {
  sessionId?: string;
  threadId?: string;
  roomId?: string | null;
}

type TaskAgentRoutingCoordinator = Pick<
  ISwarmCoordinatorService,
  "getTaskContext" | "getAllTaskContexts" | "getTaskThread"
>;

type RoutingRuntime = Pick<
  AgentRuntime,
  "getRoom" | "getService" | "sendMessageToTarget"
>;

function getRoutingCoordinator(
  runtime: RoutingRuntime,
): TaskAgentRoutingCoordinator | null {
  return getSwarmCoordinatorService(runtime);
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
    // voice-policy:V3 `text` is a sub-agent's already model-composed message
    // being routed to the origin room; it is the agent's voice already, so the
    // voice gate must pass it through untouched.
    { text, source, agentVoiced: true },
  );
  return true;
}
