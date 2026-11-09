/**
 * Page-scoped providers retain authorized conversation history, never print a
 * failed wallet chain as zero, and list automations by display name.
 */
import type { IAgentRuntime, Memory, Task, UUID } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const selfApi = vi.hoisted(() => ({
  bodies: {} as Record<string, unknown>,
}));
vi.mock("../src/api/self-api.ts", () => ({
  callSelfApi: vi.fn(async ({ path }: { path: string }) =>
    path in selfApi.bodies
      ? { status: 200, body: selfApi.bodies[path] }
      : { status: 503, body: null },
  ),
}));

import {
  pageScopedContextProvider,
  pruneMainChatTail,
} from "../src/providers/page-scoped-context.ts";
import { renderLiveStateForScope } from "../src/providers/page-scoped-live-state.ts";

const agentId = "00000000-0000-0000-0000-00000000000a" as UUID;
const userId = "00000000-0000-0000-0000-00000000000b" as UUID;
const roomId = "00000000-0000-0000-0000-00000000000c" as UUID;

function message(index: number, entityId: UUID, at: number): Memory {
  return {
    id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}` as UUID,
    agentId,
    entityId,
    roomId,
    content: { text: `message ${index}` },
    createdAt: at,
  };
}

function fakeRuntime(overrides: Partial<IAgentRuntime>): IAgentRuntime {
  return {
    agentId,
    character: { name: "Eliza" },
    reportError: vi.fn(),
    getMemories: vi.fn(async () => []),
    getTasks: vi.fn(async () => []),
    ...overrides,
  } as unknown as IAgentRuntime;
}

beforeEach(() => {
  selfApi.bodies = {};
});

describe("pruneMainChatTail", () => {
  it("keeps a trailing assistant reply after the user's message", () => {
    const now = Date.now();
    const tail = pruneMainChatTail(
      [message(2, agentId, now - 1000), message(1, userId, now - 2000)],
      agentId,
      now,
    );
    expect(tail.map((entry) => entry.content.text)).toEqual([
      "message 1",
      "message 2",
    ]);
  });

  it("drops a tail with no user message", () => {
    const now = Date.now();
    expect(pruneMainChatTail([message(1, agentId, now)], agentId, now)).toEqual(
      [],
    );
  });
});

describe("page-scoped source tail", () => {
  it("reads the complete authorized source history from a 500-message room", async () => {
    const now = Date.now();
    const rows = Array.from({ length: 500 }, (_, index) =>
      message(index, index % 2 === 0 ? userId : agentId, now - (500 - index)),
    );
    rows[0].content.text = `message 0 ${"complete source content ".repeat(1000)}`;
    const getMemories = vi.fn(async () => rows);
    const runtime = fakeRuntime({
      getRoom: vi.fn(async () => ({
        id: roomId,
        metadata: {
          webConversation: {
            conversationId: "page-1",
            scope: "page-connectors",
            sourceConversationId: "main-1",
          },
        },
      })) as never,
      getMemories: getMemories as never,
    });

    const result = await pageScopedContextProvider.get(
      runtime,
      { roomId, entityId: userId, content: { text: "hi" } } as Memory,
      {} as never,
    );

    expect(getMemories).toHaveBeenCalledWith({
      roomId: stringToUuid("web-conv-main-1"),
      tableName: "messages",
      orderBy: "createdAt",
      orderDirection: "desc",
      includeEmbedding: false,
    });
    const lines = (result.text ?? "")
      .split("\n")
      .filter((line) => line.includes("message "));
    expect(lines).toHaveLength(500);
    expect(lines[0]).toContain(rows[0].content.text);
    expect(lines.at(-1)).toContain("message 499");
  });
});

describe("page-scoped live state", () => {
  it("reads documents with a bound and no embeddings", async () => {
    const getMemories = vi.fn(async () => []);
    const runtime = fakeRuntime({ getMemories: getMemories as never });
    await renderLiveStateForScope(runtime, "page-knowledge");
    expect(getMemories).toHaveBeenCalledWith(
      expect.objectContaining({
        tableName: "documents",
        limit: 500,
        orderDirection: "desc",
        includeEmbedding: false,
      }),
    );
  });

  it("says 'at least' when the document cap is hit", async () => {
    const now = Date.now();
    const docs = Array.from({ length: 500 }, (_, index) => ({
      ...message(index, userId, now),
      metadata: { tags: ["attachment"], addedAt: now },
    }));
    const runtime = fakeRuntime({
      getMemories: vi.fn(async () => docs) as never,
    });
    const text = await renderLiveStateForScope(runtime, "page-knowledge");
    expect(text).toContain("at least 500 ingested chat attachments");
  });

  it("names a failed chain and prints no inventory total", async () => {
    selfApi.bodies["/api/wallet/balances"] = {
      evm: {
        address: "0xabc",
        chains: [
          {
            chain: "Base",
            chainId: 8453,
            nativeBalance: "0",
            nativeSymbol: "ETH",
            nativeValueUsd: "0",
            tokens: [],
            error: "rpc timeout",
          },
          {
            chain: "Ethereum",
            chainId: 1,
            nativeBalance: "1.5",
            nativeSymbol: "ETH",
            nativeValueUsd: "0",
            tokens: [],
            error: null,
          },
        ],
      },
      solana: null,
    };
    const text = await renderLiveStateForScope(fakeRuntime({}), "page-wallet");
    expect(text).toContain("Balances unavailable for Base.");
    expect(text).not.toContain("Token inventory:");
    expect(text).toContain("1.5 ETH");
  });

  it("lists automations by display name and hides internal tasks", async () => {
    const tasks = [
      {
        id: "t1",
        name: "TRIGGER_DISPATCH",
        tags: ["repeat", "trigger"],
        metadata: {
          trigger: {
            triggerId: "trg-1",
            enabled: true,
            triggerType: "interval",
            intervalMs: 3_600_000,
            displayName: "Morning digest",
            instructions: "Summarize overnight email",
          },
        },
      },
      {
        id: "t2",
        name: "Renew passport",
        tags: ["workbench-task"],
        metadata: {},
      },
      { id: "t3", name: "EMBEDDING_DRAIN", tags: ["queue"], metadata: {} },
    ] as unknown as Task[];
    const runtime = fakeRuntime({
      getTasks: vi.fn(async () => tasks) as never,
    });
    const text = await renderLiveStateForScope(runtime, "page-automations");
    expect(text).toContain("2 automations");
    expect(text).toContain("[active] Morning digest (every 1h)");
    expect(text).toContain("Renew passport");
    expect(text).not.toContain("TRIGGER_DISPATCH");
    expect(text).not.toContain("EMBEDDING_DRAIN");
  });
});
