/**
 * Unit coverage for automationTerminalBridgeProvider: ADMIN gating, automation
 * metadata / terminal-bridge id resolution, self-link suppression, empty and
 * unsorted terminal-message queues, oldest-first ordering with createdAt ties,
 * speaker + relative-time rendering, and fail-closed error handling. The
 * provider is real; only I/O collaborators (getRoom / getMemories / getWorld)
 * are stubbed.
 */
import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { logger, stringToUuid, toWellFormedUnicode } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatRelativeTimestampPrefix } from "../shared/conversation-format.ts";
import { automationTerminalBridgeProvider } from "./automation-terminal-bridge.ts";

const OWNER_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const GUEST_ID = "00000000-0000-4000-8000-000000000002" as UUID;
const AGENT_ID = "00000000-0000-4000-8000-000000000003" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-0000000000aa" as UUID;
const TERMINAL_CONV_ID = "term-conv-bridge-1";

const EMPTY_STATE: State = { values: {}, data: {}, text: "" };

const EMPTY_RESULT = {
  text: "",
  values: {},
  data: {},
};

function getBridge(runtime: IAgentRuntime, message: Memory) {
  return automationTerminalBridgeProvider.get(runtime, message, EMPTY_STATE);
}

function ownerMessage(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "00000000-0000-4000-8000-0000000000cc" as UUID,
    entityId: OWNER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text: "status?", source: "test" },
    createdAt: Date.now(),
    ...overrides,
  } as Memory;
}

function automationRoom(overrides: Record<string, unknown> = {}) {
  return {
    id: ROOM_ID,
    metadata: {
      webConversation: {
        conversationId: "auto-room-1",
        scope: "automation-coordinator",
        terminalBridgeConversationId: TERMINAL_CONV_ID,
        ...overrides,
      },
    },
  };
}

function makeRuntime(
  options: {
    room?: unknown;
    memories?: Memory[];
    getRoom?: IAgentRuntime["getRoom"];
    getMemories?: IAgentRuntime["getMemories"];
  } = {},
): IAgentRuntime {
  const getRoom =
    options.getRoom ?? vi.fn(async () => options.room ?? automationRoom());
  const getMemories =
    options.getMemories ?? vi.fn(async () => options.memories ?? []);
  return {
    agentId: AGENT_ID,
    character: { name: "BridgeAgent" },
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ID : undefined,
    getWorld: vi.fn(async () => null),
    getRoom,
    getMemories,
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
}

function terminalMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "00000000-0000-4000-8000-000000000101" as UUID,
    entityId: OWNER_ID,
    agentId: AGENT_ID,
    roomId: stringToUuid(`web-conv-${TERMINAL_CONV_ID}`) as UUID,
    content: { text: "hello from terminal", source: "web" },
    createdAt: 1_700_000_000_000,
    ...overrides,
  } as Memory;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("automationTerminalBridgeProvider registration", () => {
  it("exposes the automation/agent_internal ADMIN gate and turn cache", () => {
    expect(automationTerminalBridgeProvider.name).toBe(
      "automation-terminal-bridge",
    );
    expect(automationTerminalBridgeProvider.position).toBe(5);
    expect(automationTerminalBridgeProvider.dynamic).toBe(true);
    expect(automationTerminalBridgeProvider.contexts).toEqual([
      "automation",
      "agent_internal",
    ]);
    expect(automationTerminalBridgeProvider.contextGate).toEqual({
      anyOf: ["automation", "agent_internal"],
    });
    expect(automationTerminalBridgeProvider.roleGate).toEqual({
      minRole: "ADMIN",
    });
    expect(automationTerminalBridgeProvider.cacheStable).toBe(false);
    expect(automationTerminalBridgeProvider.cacheScope).toBe("turn");
  });
});

describe("automationTerminalBridgeProvider.get", () => {
  it("returns empty context when the sender is not ADMIN", async () => {
    const runtime = makeRuntime({
      memories: [terminalMemory()],
    });
    const result = await getBridge(
      runtime,
      ownerMessage({
        entityId: GUEST_ID,
        content: { text: "status?", source: "discord" },
      }),
    );
    expect(result).toEqual(EMPTY_RESULT);
    // hasAdminAccess may consult getRoom while resolving the sender role;
    // the provider must still fail closed before loading terminal memories.
    expect(runtime.getMemories).not.toHaveBeenCalled();
  });

  it("returns empty context when the room is not automation-scoped", async () => {
    const runtime = makeRuntime({
      room: {
        id: ROOM_ID,
        metadata: {
          webConversation: {
            conversationId: "page-1",
            scope: "page-settings",
            terminalBridgeConversationId: TERMINAL_CONV_ID,
          },
        },
      },
      memories: [terminalMemory()],
    });
    const result = await getBridge(runtime, ownerMessage());
    expect(result).toEqual(EMPTY_RESULT);
    expect(runtime.getMemories).not.toHaveBeenCalled();
  });

  it("returns empty context when the room has no conversation metadata", async () => {
    const runtime = makeRuntime({
      room: { id: ROOM_ID, metadata: {} },
      memories: [terminalMemory()],
    });
    const result = await getBridge(runtime, ownerMessage());
    expect(result).toEqual(EMPTY_RESULT);
  });

  it("returns empty context when getRoom yields null", async () => {
    const runtime = makeRuntime({
      getRoom: vi.fn(async () => null),
      memories: [terminalMemory()],
    });
    const result = await getBridge(runtime, ownerMessage());
    expect(result).toEqual(EMPTY_RESULT);
  });

  it("returns empty context when automation metadata has no terminal bridge id", async () => {
    const runtime = makeRuntime({
      room: automationRoom({ terminalBridgeConversationId: undefined }),
      memories: [terminalMemory()],
    });
    const result = await getBridge(runtime, ownerMessage());
    expect(result).toEqual(EMPTY_RESULT);
    expect(runtime.getMemories).not.toHaveBeenCalled();
  });

  it("returns empty context when the terminal bridge id is an empty string", async () => {
    const runtime = makeRuntime({
      room: automationRoom({ terminalBridgeConversationId: "   " }),
      memories: [terminalMemory()],
    });
    const result = await getBridge(runtime, ownerMessage());
    expect(result).toEqual(EMPTY_RESULT);
    expect(runtime.getMemories).not.toHaveBeenCalled();
  });

  it("returns empty context when the current room is the linked terminal room", async () => {
    const sourceRoomId = stringToUuid(`web-conv-${TERMINAL_CONV_ID}`) as UUID;
    const runtime = makeRuntime({
      memories: [terminalMemory()],
    });
    const result = await getBridge(
      runtime,
      ownerMessage({ roomId: sourceRoomId }),
    );
    expect(result).toEqual(EMPTY_RESULT);
    expect(runtime.getMemories).not.toHaveBeenCalled();
  });

  it("returns empty context for an empty terminal message queue", async () => {
    const runtime = makeRuntime({ memories: [] });
    const result = await getBridge(runtime, ownerMessage());
    expect(result).toEqual(EMPTY_RESULT);
    expect(runtime.getMemories).toHaveBeenCalledWith({
      roomId: stringToUuid(`web-conv-${TERMINAL_CONV_ID}`),
      tableName: "messages",
    });
  });

  it("returns empty context when every queued memory lacks text", async () => {
    const runtime = makeRuntime({
      memories: [
        terminalMemory({ content: { text: "" } }),
        terminalMemory({
          id: "00000000-0000-4000-8000-000000000102" as UUID,
          content: { text: undefined as unknown as string },
        }),
      ],
    });
    const result = await getBridge(runtime, ownerMessage());
    expect(result).toEqual(EMPTY_RESULT);
  });

  it("renders a single terminal message oldest-first with speaker and age", async () => {
    const createdAt = Date.now() - 5_000;
    const mem = terminalMemory({
      createdAt,
      content: { text: "operator ping", source: "web" },
      metadata: { displayName: "Ada" },
    });
    const runtime = makeRuntime({ memories: [mem] });

    const result = await getBridge(runtime, ownerMessage());

    const age = formatRelativeTimestampPrefix(createdAt);
    expect(result.text).toBe(
      `Linked terminal conversation:\n${age}Ada: operator ping`,
    );
    expect(result.values).toEqual({
      terminalBridgeConversationId: TERMINAL_CONV_ID,
      terminalBridgeMessageCount: 1,
    });
    expect(result.data).toEqual({
      conversationId: TERMINAL_CONV_ID,
      messages: [
        {
          id: mem.id,
          roomId: mem.roomId,
          entityId: mem.entityId,
          text: "operator ping",
          createdAt,
        },
      ],
    });
  });

  it("sorts an unsorted queue oldest-first and keeps tied createdAt in input order", async () => {
    const tied = 1_700_000_100_000;
    const late = terminalMemory({
      id: "00000000-0000-4000-8000-000000000201" as UUID,
      createdAt: 1_700_000_300_000,
      content: { text: "third" },
      metadata: { displayName: "C" },
    });
    const firstTie = terminalMemory({
      id: "00000000-0000-4000-8000-000000000202" as UUID,
      createdAt: tied,
      content: { text: "tie-a" },
      metadata: { displayName: "A" },
    });
    const missingCreatedAt = terminalMemory({
      id: "00000000-0000-4000-8000-000000000203" as UUID,
      createdAt: undefined,
      content: { text: "no-ts" },
      metadata: { displayName: "Z" },
    });
    const secondTie = terminalMemory({
      id: "00000000-0000-4000-8000-000000000204" as UUID,
      createdAt: tied,
      content: { text: "tie-b" },
      metadata: { displayName: "B" },
    });
    const runtime = makeRuntime({
      memories: [late, firstTie, missingCreatedAt, secondTie],
    });

    const result = await getBridge(runtime, ownerMessage());

    const lines = (result.text ?? "").split("\n");
    expect(lines[0]).toBe("Linked terminal conversation:");
    expect(lines[1]).toContain("Z: no-ts");
    expect(lines[2]).toContain("A: tie-a");
    expect(lines[3]).toContain("B: tie-b");
    expect(lines[4]).toContain("C: third");
    expect(result.values?.terminalBridgeMessageCount).toBe(4);
    expect(
      (result.data as { messages: Array<{ text?: string }> }).messages.map(
        (entry) => entry.text,
      ),
    ).toEqual(["no-ts", "tie-a", "tie-b", "third"]);
  });

  it("drops textless entries and still renders the remaining queue", async () => {
    const kept = terminalMemory({
      id: "00000000-0000-4000-8000-000000000301" as UUID,
      content: { text: "kept" },
      metadata: { displayName: "Keeper" },
      createdAt: Date.now() - 1_000,
    });
    const runtime = makeRuntime({
      memories: [
        terminalMemory({
          id: "00000000-0000-4000-8000-000000000302" as UUID,
          content: { text: "" },
        }),
        kept,
      ],
    });

    const result = await getBridge(runtime, ownerMessage());
    expect(result.values?.terminalBridgeMessageCount).toBe(1);
    expect(result.text).toContain("Keeper: kept");
    expect(result.text).not.toContain("Keeper: \n");
  });

  it("labels the agent by character name when the memory entity is the agent", async () => {
    const mem = terminalMemory({
      entityId: AGENT_ID,
      content: { text: "ack" },
      createdAt: Date.now() - 1_000,
    });
    const runtime = makeRuntime({ memories: [mem] });
    const result = await getBridge(runtime, ownerMessage());
    expect(result.text).toContain("BridgeAgent: ack");
  });

  it("sanitizes lone surrogates in terminal text via toWellFormedUnicode", async () => {
    const malformed = `hi \uD800 there`;
    const mem = terminalMemory({
      content: { text: malformed },
      metadata: { displayName: "Op" },
      createdAt: Date.now() - 1_000,
    });
    const runtime = makeRuntime({ memories: [mem] });
    const result = await getBridge(runtime, ownerMessage());
    expect(result.text).toContain(`Op: ${toWellFormedUnicode(malformed)}`);
    expect(result.text).not.toContain("\uD800");
  });

  it("does not cap the queue: more than eight visible messages all render", async () => {
    const memories = Array.from({ length: 9 }, (_, index) =>
      terminalMemory({
        id: `00000000-0000-4000-8000-0000000004${String(index).padStart(2, "0")}` as UUID,
        createdAt: 1_700_000_000_000 + index,
        content: { text: `msg-${index}` },
        metadata: { displayName: "Op" },
      }),
    );
    const runtime = makeRuntime({ memories });
    const result = await getBridge(runtime, ownerMessage());
    expect(result.values?.terminalBridgeMessageCount).toBe(9);
    for (let index = 0; index < 9; index++) {
      expect(result.text).toContain(`Op: msg-${index}`);
    }
  });

  it("accepts every automation scope that isAutomationConversationMetadata allows", async () => {
    const scopes = [
      "automation-coordinator",
      "automation-workflow",
      "automation-workflow-draft",
      "automation-draft",
    ] as const;
    for (const scope of scopes) {
      const mem = terminalMemory({
        content: { text: `from-${scope}` },
        metadata: { displayName: "Op" },
        createdAt: Date.now() - 1_000,
      });
      const runtime = makeRuntime({
        room: automationRoom({ scope }),
        memories: [mem],
      });
      const result = await getBridge(runtime, ownerMessage());
      expect(result.text).toContain(`Op: from-${scope}`);
      expect(result.values?.terminalBridgeConversationId).toBe(
        TERMINAL_CONV_ID,
      );
    }
  });

  it("logs and returns empty context when getRoom throws an Error", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const runtime = makeRuntime({
      getRoom: vi.fn(async () => {
        throw new Error("room store down");
      }),
    });
    const result = await getBridge(runtime, ownerMessage());
    expect(result).toEqual(EMPTY_RESULT);
    expect(errorSpy).toHaveBeenCalledWith(
      "[automation-terminal-bridge] Error:",
      "room store down",
    );
  });

  it("stringifies a non-Error throw and still fails closed", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const runtime = makeRuntime({
      getMemories: vi.fn(async () => {
        throw "memories exploded";
      }),
    });
    const result = await getBridge(runtime, ownerMessage());
    expect(result).toEqual(EMPTY_RESULT);
    expect(errorSpy).toHaveBeenCalledWith(
      "[automation-terminal-bridge] Error:",
      "memories exploded",
    );
  });
});
