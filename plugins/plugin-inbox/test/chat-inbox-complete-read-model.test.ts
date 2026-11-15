/**
 * Replays the cases of quint/ChatInboxCompleteRead.qnt through
 * fetchAllMessages on a real PGLite AgentRuntime. Each history is stored as
 * Discord DM memories in its own room; the room is deleted before the next
 * history. A vi.spyOn on runtime.getMemoriesByRoomIds calls through to the
 * database and counts the pages the scan reads.
 */

import { readFileSync } from "node:fs";
import {
  type AgentRuntime,
  ChannelType,
  type Memory,
  stringToUuid,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app/test/helpers/real-runtime.ts";
import { fetchAllMessages } from "../src/inbox/message-fetcher.ts";

/** The model's NoLimit: the caller passes no limit. */
const NO_LIMIT = -1;

/** A history, a limit, and what the model says the read does. */
interface ModelCase {
  agents: number;
  users: number;
  limit: number;
  pages: number;
  returned: number;
}

const HISTORIES = [0, 3].flatMap((agents) =>
  [0, 1, 200, 201, 600].map((users) => ({
    agents,
    users,
    name: `${users} user messages, ${agents} agent replies`,
  })),
);

/** Used when the conformance script does not pass generated cases. */
const DEFAULT_CASES: ModelCase[] = HISTORIES.map(({ agents, users }) => ({
  agents,
  users,
  limit: NO_LIMIT,
  pages: Math.floor((agents + users) / 600) + 1,
  returned: users,
}));

const casesFile = process.env.ELIZA_CHAT_INBOX_COMPLETE_READ_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

const userText = (index: number) => `user message ${index}`;

describe("chat inbox complete read model", () => {
  let testResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "chat-inbox-complete-read-model",
    });
    runtime = testResult.runtime;
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  /** Stores the history in a new Discord DM room and returns the room id. */
  async function storeHistory(agents: number, users: number) {
    const key = `chat-inbox-model-${agents}-${users}`;
    const roomId = stringToUuid(`${key}-room`);
    const entityId = stringToUuid(`${key}-user`);
    await runtime.ensureConnection({
      entityId,
      roomId,
      worldId: stringToUuid(`${key}-world`),
      worldName: "discord",
      userName: "Ada",
      name: "Ada",
      source: "discord",
      type: ChannelType.DM,
      channelId: `${key}-channel`,
    });
    const base = Date.now() - 2 * 60 * 60_000;
    const memories: Memory[] = [];
    for (let index = 0; index < users; index += 1) {
      memories.push({
        id: stringToUuid(`${key}-user-${index}`),
        agentId: runtime.agentId,
        roomId,
        entityId,
        content: { text: userText(index), source: "discord" },
        metadata: { type: "message", entityName: "Ada" },
        createdAt: base + index * 1_000,
      });
    }
    for (let index = 0; index < agents; index += 1) {
      memories.push({
        id: stringToUuid(`${key}-agent-${index}`),
        agentId: runtime.agentId,
        roomId,
        entityId: runtime.agentId,
        content: { text: `agent reply ${index}`, source: "discord" },
        metadata: { type: "message" },
        createdAt: base + (users + index) * 1_000,
      });
    }
    if (memories.length > 0) {
      await runtime.createMemories(
        memories.map((memory) => ({ memory, tableName: "messages" })),
      );
    }
    return roomId;
  }

  async function replay(
    item: ModelCase,
  ): Promise<Pick<ModelCase, "pages" | "returned">> {
    const reads = vi.spyOn(runtime, "getMemoriesByRoomIds");
    try {
      const { messages } = await fetchAllMessages(runtime, {
        sources: ["discord"],
        ...(item.limit === NO_LIMIT ? {} : { limit: item.limit }),
      });
      // The newest user messages, newest first.
      expect(messages.map((message) => message.text)).toEqual(
        Array.from({ length: messages.length }, (_, index) =>
          userText(item.users - 1 - index),
        ),
      );
      return { pages: reads.mock.calls.length, returned: messages.length };
    } finally {
      reads.mockRestore();
    }
  }

  it.each(HISTORIES.map((history) => history.name))(
    "replays reads of %s",
    async (name) => {
      const history = HISTORIES.find((item) => item.name === name);
      if (!history) throw new Error(`unknown history ${name}`);
      const group = cases.filter(
        (item) =>
          item.agents === history.agents && item.users === history.users,
      );
      expect(group.length).toBeGreaterThan(0);
      const roomId = await storeHistory(history.agents, history.users);
      try {
        for (const item of group) {
          const observed = await replay(item);
          expect(observed, `limit ${item.limit}`).toEqual({
            pages: item.pages,
            returned: item.returned,
          });
        }
      } finally {
        await runtime.deleteRoom(roomId);
      }
    },
    120_000,
  );
});
