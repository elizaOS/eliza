/**
 * Covers routeTaskAgentTextToConnector: null runtime, empty / single / tied
 * in-flight task queues, login-label inference, session→thread→room resolution
 * (including missing coordinator methods and blank thread room ids), getRoom
 * failures, and confirmed vs unconfirmed connector delivery. Drives the real
 * module with an in-memory runtime; no live model or network.
 */
import {
  type AgentRuntime,
  type SendHandlerOutcome,
  SWARM_COORDINATOR_SERVICE_TYPE,
  type SwarmCoordinatorTaskContext,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  routeTaskAgentTextToConnector,
  type TaskAgentChatRouting,
} from "./task-agent-message-routing";

const ROOM_ID = "00000000-0000-4000-8000-0000000000b1" as UUID;
const OTHER_ROOM_ID = "00000000-0000-4000-8000-0000000000b2" as UUID;
const THREAD_ID = "thread-1";
const SESSION_ID = "session-1";

function confirmedDelivery(): SendHandlerOutcome {
  return {
    kind: "delivered",
    receipt: {
      providerMessageIds: ["task-agent-provider-1"],
      acceptedAt: 1_780_000_000_000,
      persistence: { status: "persisted", memoryIds: [] },
    },
    memories: [],
  };
}

function task(
  overrides: SwarmCoordinatorTaskContext = {},
): SwarmCoordinatorTaskContext {
  return { ...overrides };
}

function makeCoordinator(
  options: {
    tasks?: SwarmCoordinatorTaskContext[];
    contextBySession?: Record<string, SwarmCoordinatorTaskContext | null>;
    threadById?: Record<
      string,
      { roomId?: string | number | null } | null | undefined
    >;
    omitAllTasks?: boolean;
    omitContext?: boolean;
    omitThread?: boolean;
  } = {},
) {
  return {
    getAllTaskContexts: options.omitAllTasks
      ? undefined
      : vi.fn(() => options.tasks ?? []),
    getTaskContext: options.omitContext
      ? undefined
      : vi.fn(
          (sessionId: string) => options.contextBySession?.[sessionId] ?? null,
        ),
    getTaskThread: options.omitThread
      ? undefined
      : vi.fn(async (threadId: string) =>
          Object.hasOwn(options.threadById ?? {}, threadId)
            ? (options.threadById?.[threadId] ?? null)
            : null,
        ),
  };
}

function makeRuntime(options: {
  coordinator?: ReturnType<typeof makeCoordinator> | null;
  room?: {
    id: UUID;
    source?: string;
    channelId?: string;
    serverId?: string | null;
  } | null;
  getRoomError?: Error;
  sendOutcome?: SendHandlerOutcome;
  returnUnconfirmedSend?: boolean;
}): AgentRuntime {
  const getRoom = vi.fn(async (_roomId: UUID) => {
    if (options.getRoomError) throw options.getRoomError;
    return options.room === undefined
      ? { id: ROOM_ID, source: "discord", channelId: "channel-1" }
      : options.room;
  });
  const sendMessageToTarget = vi.fn(async () =>
    options.returnUnconfirmedSend
      ? undefined
      : (options.sendOutcome ?? confirmedDelivery()),
  );
  const getService = vi.fn((serviceType: string) =>
    serviceType === SWARM_COORDINATOR_SERVICE_TYPE
      ? (options.coordinator ?? null)
      : null,
  );
  return {
    getRoom,
    getService,
    sendMessageToTarget,
  } as unknown as AgentRuntime;
}

describe("routeTaskAgentTextToConnector — admission and room resolution", () => {
  it("returns false when the runtime is missing", async () => {
    await expect(
      routeTaskAgentTextToConnector(null, "hello", "task-agent"),
    ).resolves.toBe(false);
  });

  it("returns false when no room can be resolved from routing or tasks", async () => {
    const runtime = makeRuntime({
      coordinator: makeCoordinator({ tasks: [] }),
    });
    await expect(
      routeTaskAgentTextToConnector(runtime, "hello", "task-agent"),
    ).resolves.toBe(false);
    expect(runtime.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("returns false when getRoom rejects or the room has no source", async () => {
    const thrown = makeRuntime({
      getRoomError: new Error("room store down"),
      coordinator: makeCoordinator(),
    });
    await expect(
      routeTaskAgentTextToConnector(thrown, "hello", "task-agent", {
        roomId: ROOM_ID,
      }),
    ).resolves.toBe(false);
    expect(thrown.sendMessageToTarget).not.toHaveBeenCalled();

    const sourceless = makeRuntime({
      room: { id: ROOM_ID },
    });
    await expect(
      routeTaskAgentTextToConnector(sourceless, "hello", "task-agent", {
        roomId: ROOM_ID,
      }),
    ).resolves.toBe(false);
    expect(sourceless.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("returns false for a blank explicit roomId and for a whitespace thread room", async () => {
    const blankRoom = makeRuntime({ coordinator: makeCoordinator() });
    await expect(
      routeTaskAgentTextToConnector(blankRoom, "hello", "task-agent", {
        roomId: "",
      }),
    ).resolves.toBe(false);

    const whitespace = makeRuntime({
      coordinator: makeCoordinator({
        threadById: { [THREAD_ID]: { roomId: "   " } },
      }),
    });
    await expect(
      routeTaskAgentTextToConnector(whitespace, "hello", "task-agent", {
        threadId: THREAD_ID,
      }),
    ).resolves.toBe(false);
    expect(whitespace.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("returns false when the thread roomId is missing or not a string", async () => {
    const missing = makeRuntime({
      coordinator: makeCoordinator({
        threadById: { [THREAD_ID]: {} },
      }),
    });
    await expect(
      routeTaskAgentTextToConnector(missing, "hello", "task-agent", {
        threadId: THREAD_ID,
      }),
    ).resolves.toBe(false);

    const numeric = makeRuntime({
      coordinator: makeCoordinator({
        threadById: { [THREAD_ID]: { roomId: 42 } },
      }),
    });
    await expect(
      routeTaskAgentTextToConnector(numeric, "hello", "task-agent", {
        threadId: THREAD_ID,
      }),
    ).resolves.toBe(false);
  });
});

describe("routeTaskAgentTextToConnector — explicit routing", () => {
  it("delivers through the room's source connector when roomId is given", async () => {
    const runtime = makeRuntime({
      room: {
        id: ROOM_ID,
        source: "discord",
        channelId: "channel-1",
        serverId: "server-1",
      },
    });

    await expect(
      routeTaskAgentTextToConnector(runtime, "task done", "task-agent", {
        roomId: ROOM_ID,
      }),
    ).resolves.toBe(true);

    expect(runtime.getRoom).toHaveBeenCalledWith(ROOM_ID);
    expect(runtime.sendMessageToTarget).toHaveBeenCalledOnce();
    expect(runtime.sendMessageToTarget).toHaveBeenCalledWith(
      {
        source: "discord",
        roomId: ROOM_ID,
        channelId: "channel-1",
        serverId: "server-1",
      },
      { text: "task done", source: "task-agent", agentVoiced: true },
    );
  });

  it("falls back to room.id as channelId and omits a null serverId", async () => {
    const runtime = makeRuntime({
      room: { id: ROOM_ID, source: "telegram", serverId: null },
    });

    await expect(
      routeTaskAgentTextToConnector(runtime, "ping", "swarm", {
        roomId: ROOM_ID,
      }),
    ).resolves.toBe(true);

    expect(runtime.sendMessageToTarget).toHaveBeenCalledWith(
      {
        source: "telegram",
        roomId: ROOM_ID,
        channelId: ROOM_ID,
        serverId: undefined,
      },
      { text: "ping", source: "swarm", agentVoiced: true },
    );
  });

  it("fills threadId from getTaskContext when only sessionId is given", async () => {
    const coordinator = makeCoordinator({
      contextBySession: {
        [SESSION_ID]: task({ threadId: THREAD_ID }),
      },
      threadById: { [THREAD_ID]: { roomId: ROOM_ID } },
    });
    const runtime = makeRuntime({ coordinator });

    await expect(
      routeTaskAgentTextToConnector(runtime, "update", "task-agent", {
        sessionId: SESSION_ID,
      }),
    ).resolves.toBe(true);

    expect(coordinator.getTaskContext).toHaveBeenCalledWith(SESSION_ID);
    expect(coordinator.getTaskThread).toHaveBeenCalledWith(THREAD_ID);
    expect(runtime.getRoom).toHaveBeenCalledWith(ROOM_ID);
  });

  it("does not consult getTaskContext when threadId is already present", async () => {
    const coordinator = makeCoordinator({
      threadById: { [THREAD_ID]: { roomId: ROOM_ID } },
    });
    const runtime = makeRuntime({ coordinator });

    await expect(
      routeTaskAgentTextToConnector(runtime, "update", "task-agent", {
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
      }),
    ).resolves.toBe(true);

    expect(coordinator.getTaskContext).not.toHaveBeenCalled();
    expect(coordinator.getTaskThread).toHaveBeenCalledWith(THREAD_ID);
  });

  it("prefers an explicit roomId over thread lookup", async () => {
    const coordinator = makeCoordinator({
      threadById: { [THREAD_ID]: { roomId: OTHER_ROOM_ID } },
    });
    const runtime = makeRuntime({
      coordinator,
      room: { id: ROOM_ID, source: "discord" },
    });

    await expect(
      routeTaskAgentTextToConnector(runtime, "update", "task-agent", {
        roomId: ROOM_ID,
        threadId: THREAD_ID,
      }),
    ).resolves.toBe(true);

    expect(coordinator.getTaskThread).not.toHaveBeenCalled();
    expect(runtime.getRoom).toHaveBeenCalledWith(ROOM_ID);
  });

  it("returns false when the coordinator lacks getTaskThread or getTaskContext", async () => {
    const noThread = makeRuntime({
      coordinator: makeCoordinator({ omitThread: true }),
    });
    await expect(
      routeTaskAgentTextToConnector(noThread, "hello", "task-agent", {
        threadId: THREAD_ID,
      }),
    ).resolves.toBe(false);

    const noContext = makeRuntime({
      coordinator: makeCoordinator({ omitContext: true }),
    });
    await expect(
      routeTaskAgentTextToConnector(noContext, "hello", "task-agent", {
        sessionId: SESSION_ID,
      }),
    ).resolves.toBe(false);
  });
});

describe("routeTaskAgentTextToConnector — inferred in-flight task routing", () => {
  it("uses the single in-flight task when the queue has one element", async () => {
    const coordinator = makeCoordinator({
      tasks: [
        task({
          label: "coder",
          sessionId: SESSION_ID,
          threadId: THREAD_ID,
        }),
      ],
      threadById: { [THREAD_ID]: { roomId: ROOM_ID } },
    });
    const runtime = makeRuntime({ coordinator });

    await expect(
      routeTaskAgentTextToConnector(runtime, "here is the patch", "task-agent"),
    ).resolves.toBe(true);

    expect(coordinator.getAllTaskContexts).toHaveBeenCalledOnce();
    expect(coordinator.getTaskThread).toHaveBeenCalledWith(THREAD_ID);
    expect(runtime.sendMessageToTarget).toHaveBeenCalledOnce();
  });

  it("returns false for an empty queue and for a non-array task list", async () => {
    const empty = makeRuntime({
      coordinator: makeCoordinator({ tasks: [] }),
    });
    await expect(
      routeTaskAgentTextToConnector(empty, "hello", "task-agent"),
    ).resolves.toBe(false);

    const coordinator = makeCoordinator({ omitAllTasks: true });
    coordinator.getAllTaskContexts = vi.fn(
      () => ({ not: "an-array" }) as unknown as SwarmCoordinatorTaskContext[],
    );
    const bogus = makeRuntime({ coordinator });
    await expect(
      routeTaskAgentTextToConnector(bogus, "hello", "task-agent"),
    ).resolves.toBe(false);
    expect(bogus.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("returns false when several tasks are in flight and the text names none", async () => {
    const runtime = makeRuntime({
      coordinator: makeCoordinator({
        tasks: [
          task({ label: "coder", sessionId: "s1", threadId: "t1" }),
          task({ label: "reviewer", sessionId: "s2", threadId: "t2" }),
        ],
        threadById: { t1: { roomId: ROOM_ID }, t2: { roomId: OTHER_ROOM_ID } },
      }),
    });

    await expect(
      routeTaskAgentTextToConnector(runtime, "status?", "task-agent"),
    ).resolves.toBe(false);
    expect(runtime.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("routes by a unique login-label match among several tasks", async () => {
    const coordinator = makeCoordinator({
      tasks: [
        task({ label: "coder", sessionId: "s1", threadId: "t1" }),
        task({
          label: "reviewer",
          sessionId: SESSION_ID,
          threadId: THREAD_ID,
        }),
      ],
      threadById: {
        t1: { roomId: OTHER_ROOM_ID },
        [THREAD_ID]: { roomId: ROOM_ID },
      },
    });
    const runtime = makeRuntime({ coordinator });

    await expect(
      routeTaskAgentTextToConnector(
        runtime,
        `"reviewer" needs a provider login to continue`,
        "task-agent",
      ),
    ).resolves.toBe(true);

    expect(coordinator.getTaskThread).toHaveBeenCalledWith(THREAD_ID);
    expect(runtime.getRoom).toHaveBeenCalledWith(ROOM_ID);
  });

  it("returns false when the login label is missing or tied across tasks", async () => {
    const tasks = [
      task({ label: "coder", sessionId: "s1", threadId: "t1" }),
      task({ label: "coder", sessionId: "s2", threadId: "t2" }),
    ];
    const missing = makeRuntime({
      coordinator: makeCoordinator({
        tasks,
        threadById: { t1: { roomId: ROOM_ID } },
      }),
    });
    await expect(
      routeTaskAgentTextToConnector(
        missing,
        `"reviewer" needs a provider login`,
        "task-agent",
      ),
    ).resolves.toBe(false);

    const tied = makeRuntime({
      coordinator: makeCoordinator({
        tasks,
        threadById: { t1: { roomId: ROOM_ID }, t2: { roomId: OTHER_ROOM_ID } },
      }),
    });
    await expect(
      routeTaskAgentTextToConnector(
        tied,
        `"coder" needs a provider login`,
        "task-agent",
      ),
    ).resolves.toBe(false);
    expect(tied.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it("does not infer from a login line that is not anchored at the start", async () => {
    const runtime = makeRuntime({
      coordinator: makeCoordinator({
        tasks: [
          task({ label: "coder", sessionId: "s1", threadId: "t1" }),
          task({ label: "reviewer", sessionId: "s2", threadId: THREAD_ID }),
        ],
        threadById: { [THREAD_ID]: { roomId: ROOM_ID } },
      }),
    });

    await expect(
      routeTaskAgentTextToConnector(
        runtime,
        `note: "reviewer" needs a provider login`,
        "task-agent",
      ),
    ).resolves.toBe(false);
  });

  it("skips inference when an explicit routing object is provided", async () => {
    const coordinator = makeCoordinator({
      tasks: [
        task({
          label: "coder",
          sessionId: SESSION_ID,
          threadId: THREAD_ID,
        }),
      ],
      threadById: { [THREAD_ID]: { roomId: ROOM_ID } },
    });
    const runtime = makeRuntime({ coordinator });
    const routing: TaskAgentChatRouting = {};

    await expect(
      routeTaskAgentTextToConnector(runtime, "hello", "task-agent", routing),
    ).resolves.toBe(false);
    expect(coordinator.getAllTaskContexts).not.toHaveBeenCalled();
  });

  it("fills threadId from the session after inferring a session-only task", async () => {
    const coordinator = makeCoordinator({
      tasks: [task({ label: "coder", sessionId: SESSION_ID })],
      contextBySession: {
        [SESSION_ID]: task({ threadId: THREAD_ID }),
      },
      threadById: { [THREAD_ID]: { roomId: ROOM_ID } },
    });
    const runtime = makeRuntime({ coordinator });

    await expect(
      routeTaskAgentTextToConnector(runtime, "hello", "task-agent"),
    ).resolves.toBe(true);
    expect(coordinator.getTaskContext).toHaveBeenCalledWith(SESSION_ID);
    expect(runtime.getRoom).toHaveBeenCalledWith(ROOM_ID);
  });
});

describe("routeTaskAgentTextToConnector — delivery confirmation", () => {
  it("propagates when the connector send is not confirmed", async () => {
    const runtime = makeRuntime({
      returnUnconfirmedSend: true,
    });

    await expect(
      routeTaskAgentTextToConnector(runtime, "hello", "task-agent", {
        roomId: ROOM_ID,
      }),
    ).rejects.toThrow(/not confirmed/i);
  });

  it("rejects a partially delivered send before reporting success", async () => {
    const runtime = makeRuntime({
      sendOutcome: {
        kind: "partially_delivered",
        receipt: {
          providerMessageIds: ["task-agent-provider-1"],
          acceptedAt: 1_780_000_000_000,
          persistence: { status: "persisted", memoryIds: [] },
        },
        memories: [],
        code: "PARTIAL",
        message: "second chunk failed",
      },
    });

    await expect(
      routeTaskAgentTextToConnector(runtime, "hello", "task-agent", {
        roomId: ROOM_ID,
      }),
    ).rejects.toThrow(/not confirmed/i);
  });
});
