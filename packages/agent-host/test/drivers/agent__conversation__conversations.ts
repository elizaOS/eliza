// spec/agent/conversation/conversations.md, "Story: Create and find my conversations"; spec/agent/conversation/conversations.md, "Story: Fork a conversation at a message without changing the original"; spec/agent/conversation/conversations.md, "Story: Remove private text I sent by mistake"; spec/agent/conversation/conversations.md, "No message is ever removed, and only redaction changes one"
import { randomUUID } from "node:crypto";
import { AgentRuntime, type IDatabaseAdapter, type Memory, type UUID } from "@elizaos/core";
import type { Driver, Options } from "../../gen/agent__conversation__conversations.conformance.ts";
import type { Author, Conversation, Conversations, Event, Fork, LogRow, Message, Title } from "../../gen/agent__conversation__conversations.ts";
import type { LocalRoute } from "@elizaos/agent";
import { conversationRecordRoutes, conversationStore, recordOf, type ConversationOwner, type ConversationRecord, type ConversationStore } from "../../src/conversation/conversations.vibe";
import { forkRecords, forkService, forkTitle } from "../../src/conversation/fork.vibe";
import { bodyOf, storedText } from "../../src/conversation/history.vibe";
import { redactRoutes } from "../../src/conversation/redact.vibe";
import { openDeviceStorage } from "../../src/storage/index.vibe";
import { scratchDirectory, type Scratch } from "../support/scratch.ts";

const unit = 100_000;
const notice = "[Private information removed]";
const wallClock = Date.now;

interface Opened {
  readonly scratch: Scratch;
  readonly adapter: IDatabaseAdapter;
  readonly agentId: UUID;
}

interface World {
  readonly runtime: AgentRuntime;
  readonly owner: ConversationOwner;
  readonly store: ConversationStore;
  readonly forks: ReturnType<typeof forkService>;
  readonly routes: readonly LocalRoute[];
  readonly messageIds: Map<string, number>;
  readonly digests: Map<string, number>;
  readonly base: number;
  now: number;
  tick: number;
  nextMessage: number;
}

let opened: Opened | undefined;
let world: World | undefined;

Date.now = () => world === undefined ? wallClock() : world.base + world.now * unit + ++world.tick;

async function storage(): Promise<Opened> {
  if (opened === undefined) {
    const scratch = await scratchDirectory("conversations-driver");
    const { adapter, agentId } = await openDeviceStorage({ stateDirectory: scratch.file("memory"), persistMemory: false, account: null, embeddingDimensions: 0 });
    opened = { scratch, adapter, agentId };
  }
  return opened;
}

async function fresh(): Promise<World> {
  const { adapter, agentId } = await storage();
  const runtime = new AgentRuntime({ agentId, character: { name: "Eliza", bio: [] } });
  runtime.registerDatabaseAdapter(adapter);
  await runtime.initialize({ skipMigrations: true });
  const owner = { user: randomUUID() as UUID, world: randomUUID() as UUID };
  const store = conversationStore(runtime, owner);
  return {
    runtime, owner, store, forks: forkService(runtime, store, owner.user), routes: [...conversationRecordRoutes(store), ...redactRoutes(runtime, store, owner.user)],
    messageIds: new Map(), digests: new Map(), base: wallClock(), now: 0, tick: 0, nextMessage: 1,
  };
}

async function current(): Promise<World> {
  world ??= await fresh();
  return world;
}

const modelTime = (w: World, real: number) => Math.floor((real - w.base) / unit);
const accepted = (done: boolean) => done ? "accepted" as const : "refused" as const;

async function records(w: World): Promise<ConversationRecord[]> {
  return (await w.runtime.getRooms(w.owner.world)).flatMap((room) => recordOf(room) ?? []).sort((a, b) => a.seq - b.seq);
}

async function published(w: World, seq: number) {
  return (await records(w)).find((record) => record.seq === seq && record.publication === "Published");
}

async function route(w: World, path: string, parameters: Record<string, string>, body: unknown) {
  const found = w.routes.find((candidate) => candidate.method === "POST" && candidate.path === path);
  if (found === undefined) throw new Error(`No route ${path}`);
  const answer = await found.handler({ parameters: new Map(Object.entries(parameters)), query: new Map(), headers: new Map(), body, signal: new AbortController().signal });
  if (answer instanceof Response) throw new Error(`The route ${path} streamed`);
  return answer;
}

async function storedMessages(w: World, record: ConversationRecord): Promise<Array<Memory & { id: UUID }>> {
  return (await w.runtime.adapter.getMemories({ roomId: record.roomId, tableName: "messages" }))
    .flatMap((memory) => memory.id === undefined ? [] : [memory as Memory & { id: UUID }]);
}

const sourceOf = (memory: Memory) => (memory.metadata as { forkSourceMessageId?: string } | undefined)?.forkSourceMessageId;

async function send(event: Event): Promise<"accepted" | "refused"> {
  const w = await current();
  switch (event.type) {
    case "create": {
      const title = event.titleUnits > 200 ? event.title.padEnd(201, "x") : event.title;
      return accepted((await route(w, "/api/conversations", {}, { title })).status === 201);
    }
    case "receive": {
      const record = await published(w, event.conversationId);
      if (record === undefined || event.text.trim() === "" || event.at < w.now) return "refused";
      w.now = event.at;
      const author: Record<Author, UUID> = { User: w.owner.user, Agent: w.runtime.agentId };
      const id = randomUUID() as UUID;
      const createdAt = Date.now();
      await w.runtime.adapter.createMemories([{ tableName: "messages", memory: {
        id, roomId: record.roomId, worldId: w.owner.world, agentId: w.runtime.agentId, entityId: author[event.author], createdAt, content: { text: event.text, source: "device" },
      } }]);
      await w.store.touch(record.roomId, createdAt);
      w.messageIds.set(id, w.nextMessage++);
      return "accepted";
    }
    case "logModelCall": {
      const record = await published(w, event.conversationId);
      if (record === undefined || event.text === "") return "refused";
      await w.runtime.adapter.createLogs([{ entityId: w.runtime.agentId, roomId: record.roomId, type: "useModel:TEXT_LARGE", body: { prompt: event.text }, createdAt: new Date(Date.now()) }]);
      return "accepted";
    }
    case "fork": {
      const source = await published(w, event.conversationId);
      if (source === undefined) return "refused";
      const messageId = [...w.messageIds].find(([, id]) => id === event.messageId)?.[0] ?? randomUUID();
      const before = (await records(w)).length;
      const result = await w.forks.begin(source, { messageId, requestId: event.requestId, expectedText: event.expectedText });
      if (result.kind !== "forked" || (await records(w)).length === before) return "refused";
      const copies = (await storedMessages(w, result.fork))
        .map((memory) => ({ memory, from: w.messageIds.get(String(sourceOf(memory))) ?? 0 }))
        .sort((a, b) => a.from - b.from);
      for (const { memory } of copies) w.messageIds.set(memory.id, w.nextMessage++);
      w.digests.set(result.fork.id, event.textDigest);
      return "accepted";
    }
    case "finishFork": {
      const pending = (await records(w)).find((record) => record.seq === event.forkId && record.publication === "ForkPending");
      return accepted(pending !== undefined && (await w.forks.finish(pending.id)) !== undefined);
    }
    case "redact": {
      const record = await published(w, event.conversationId);
      if (record === undefined) return "refused";
      const messageId = [...w.messageIds].find(([, id]) => id === event.messageId)?.[0] ?? randomUUID();
      const answer = await route(w, "/api/conversations/{id}/messages/{messageId}/redact", { id: record.id, messageId }, { expectedText: event.expectedText });
      return accepted(answer.status === 200 && (answer.body as { result?: unknown }).result === "redacted");
    }
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

function titleOf(text: string): Title {
  let rest = text;
  let edits = 0;
  while (rest !== forkTitle("") && rest.endsWith(forkTitle(""))) {
    rest = rest.slice(0, -forkTitle("").length);
    edits++;
  }
  return { text: rest, edits };
}

async function observe(): Promise<Conversations> {
  const w = await current();
  const held = await records(w);
  const seqOf = new Map(held.map((record) => [record.id, record.seq]));
  const conversations = held.map((record): Conversation => ({
    id: record.seq, title: titleOf(record.title), createdAt: modelTime(w, record.createdAt), updatedAt: modelTime(w, record.updatedAt), publication: record.publication,
  }));
  const messages = (await Promise.all(held.map(async (record) => Promise.all((await storedMessages(w, record)).map(async (memory): Promise<Message> => {
    const from = sourceOf(memory);
    return {
      id: w.messageIds.get(memory.id) ?? 0, conversationId: record.seq, at: modelTime(w, memory.createdAt ?? 0),
      author: memory.entityId === w.runtime.agentId ? "Agent" : "User", body: bodyOf(await storedText(w.runtime.adapter, memory)),
      origin: from === undefined ? { tag: "Original" } : { tag: "Copied", fromId: w.messageIds.get(String(from)) ?? 0 },
    };
  }))))).flat().sort((a, b) => a.id - b.id);
  const logs = (await Promise.all(held.map(async (record) => (await w.runtime.adapter.getLogs({ roomId: record.roomId })).map((row) => {
    const prompt = String((row.body as { prompt?: string }).prompt ?? "");
    return { at: row.createdAt.getTime(), row: { conversationId: record.seq, body: prompt === notice ? { tag: "Redacted" } : { tag: "Said", text: prompt } } satisfies LogRow };
  })))).flat().sort((a, b) => a.at - b.at).map(({ row }) => row);
  const forks = (await Promise.all(held.map(async (record) => (await forkRecords(w.runtime, record)).map((kept): Fork => ({
    forkId: seqOf.get(kept.forkId) ?? 0, source: record.seq, requestId: kept.requestId, boundary: w.messageIds.get(kept.boundary) ?? 0,
    boundaryAt: modelTime(w, kept.boundaryAt), textDigest: w.digests.get(kept.forkId) ?? 0,
  }))))).flat().sort((a, b) => a.forkId - b.forkId);
  return {
    conversations, messages, log: logs, forks,
    nextConversation: Math.max(0, ...held.map((record) => record.seq)) + 1, nextMessage: w.nextMessage, now: w.now,
  };
}

export const driver: Driver & { [Symbol.asyncDispose](): Promise<void> } = {
  async reset() {
    world = undefined;
    world = await fresh();
  },
  dispatch: (_key, event) => send(event),
  observe: () => observe(),
  async [Symbol.asyncDispose]() {
    world = undefined;
    Date.now = wallClock;
    if (opened !== undefined) {
      await opened.adapter.close();
      await opened.scratch.remove();
      opened = undefined;
    }
  },
};

export const options: Options = {
  keys: ["owner"],
};
