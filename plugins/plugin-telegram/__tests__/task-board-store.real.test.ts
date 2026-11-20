/**
 * The pinned task board (#8902) on a real PGlite runtime with a loopback Bot
 * API. `/tasks` runs through registerTelegramTaskBoardCommand, the
 * registration TelegramService uses, so the board message id goes through
 * createRuntimeMemoryBoardStore into plugin-sql. An agent restart is a new
 * runtime on the same PGlite directory. Only the Bot API host is local.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type IAgentRuntime,
  type Plugin,
  Service,
  stringToUuid,
} from "@elizaos/core";
import { createRealTestRuntime } from "@elizaos/testing/runtime";
import { Telegraf } from "telegraf";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MessageManager } from "../src/messageManager.ts";
import { registerTelegramTaskBoardCommand } from "../src/task-board.ts";

// Event kinds and Bot API calls of quint/TelegramTaskBoardStore.qnt.
const TASKS = 1;
const RESTART = 2;
const DELETE = 3;

interface ModelCase {
  events: number[];
  calls: string[];
  visible: number[];
  stored: number;
  pinned: number;
  posts: number;
  edits: number;
}

// Without generated cases (an ordinary test run) these cases from the model
// run; quint/check-telegram-task-board-store.mjs replays every generated case.
const DEFAULT_CASES: ModelCase[] = [
  {
    events: [TASKS, TASKS, RESTART, TASKS],
    calls: [
      "sendMessage",
      "pinChatMessage",
      "editMessageText",
      "editMessageText",
    ],
    visible: [1],
    stored: 1,
    pinned: 1,
    posts: 1,
    edits: 2,
  },
  {
    events: [TASKS, DELETE, RESTART, TASKS],
    calls: [
      "sendMessage",
      "pinChatMessage",
      "editMessageText",
      "sendMessage",
      "pinChatMessage",
    ],
    visible: [2],
    stored: 2,
    pinned: 2,
    posts: 2,
    edits: 0,
  },
];
const casesFile = process.env.ELIZA_TELEGRAM_TASK_BOARD_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

// Each `/tasks` follows a task status change, so each render has new text.
const STATUSES = ["active", "validating", "waiting_on_user", "blocked", "done"];
let status = STATUSES[0];

/** The orchestrator task list that the board reads. */
class ListedTaskService extends Service {
  static serviceType = "ORCHESTRATOR_TASK_SERVICE";
  capabilityDescription = "Task list for the Telegram task board test";
  static async start(runtime: IAgentRuntime): Promise<Service> {
    return new ListedTaskService(runtime);
  }
  async stop(): Promise<void> {}
  async listTasks() {
    return [{ id: "board-task", title: "ship the task board", status }];
  }
}
const taskPlugin: Plugin = {
  name: "telegram-task-board-store-tasks",
  description: "Task list for the Telegram task board test",
  services: [ListedTaskService],
};

interface ChatState {
  calls: string[];
  /** Message ids of the bot's posts, in post order. */
  posted: number[];
  texts: Map<number, string>;
  deleted: Set<number>;
  pinned: number;
  edits: number;
}

const chats = new Map<number, ChatState>();
let server: Server;
let apiRoot = "";
let nextMessageId = 500;

function chatState(chatId: number): ChatState {
  let chat = chats.get(chatId);
  if (!chat) {
    chat = {
      calls: [],
      posted: [],
      texts: new Map(),
      deleted: new Set(),
      pinned: 0,
      edits: 0,
    };
    chats.set(chatId, chat);
  }
  return chat;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const method = (request.url ?? "").split("/").pop() ?? "";
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      response.setHeader("content-type", "application/json");
      const ok = (result: unknown) =>
        response.end(JSON.stringify({ ok: true, result }));
      const refuse = (description: string) => {
        response.statusCode = 400;
        response.end(
          JSON.stringify({ ok: false, error_code: 400, description }),
        );
      };
      if (method === "getMe") {
        return ok({
          id: 8902,
          is_bot: true,
          first_name: "Board",
          username: "task_board_bot",
        });
      }
      const chat = chatState(Number(body.chat_id));
      chat.calls.push(method);
      const message = (id: number) => ({
        message_id: id,
        date: 1,
        chat: { id: Number(body.chat_id), type: "supergroup" },
        text: chat.texts.get(id),
      });
      if (method === "sendMessage") {
        const id = nextMessageId++;
        chat.posted.push(id);
        chat.texts.set(id, body.text);
        return ok(message(id));
      }
      if (method === "pinChatMessage") {
        if (
          !chat.texts.has(body.message_id) ||
          chat.deleted.has(body.message_id)
        )
          return refuse("Bad Request: message to pin not found");
        chat.pinned = body.message_id;
        return ok(true);
      }
      if (method === "editMessageText") {
        if (
          !chat.texts.has(body.message_id) ||
          chat.deleted.has(body.message_id)
        )
          return refuse("Bad Request: message to edit not found");
        // Telegram refuses an edit that does not change the message.
        if (chat.texts.get(body.message_id) === body.text)
          return refuse(
            "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
          );
        chat.texts.set(body.message_id, body.text);
        chat.edits += 1;
        return ok(message(body.message_id));
      }
      return refuse(`Bad Request: method ${method} is not used here`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Agent {
  runtime: IAgentRuntime;
  bot: Telegraf;
  cleanup: () => Promise<void>;
}

/** Starts the agent on the PGlite directory and registers `/tasks`. */
async function startAgent(pgliteDir: string): Promise<Agent> {
  const { runtime, cleanup } = await createRealTestRuntime({
    characterName: "TaskBoardAgent",
    pgliteDir,
    removePgliteDirOnCleanup: false,
    plugins: [taskPlugin],
  });
  await runtime.getServiceLoadPromise("ORCHESTRATOR_TASK_SERVICE" as never);
  const bot = new Telegraf("8902:TASK_BOARD_STORE_LOCAL_ONLY", {
    telegram: { apiRoot },
  });
  registerTelegramTaskBoardCommand(
    bot as never,
    runtime,
    new MessageManager(bot, runtime, "default"),
  );
  return { runtime, bot, cleanup };
}

let updateId = 0;
async function runTasks(agent: Agent, chatId: number): Promise<void> {
  updateId += 1;
  await agent.bot.handleUpdate({
    update_id: updateId,
    message: {
      message_id: 10_000 + updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "supergroup", title: "Ops" },
      from: { id: 777, is_bot: false, first_name: "Owner" },
      text: "/tasks",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    },
  } as never);
}

/** Runs the case's events in one chat and returns what the chat shows. */
async function replay(
  events: number[],
  chatId: number,
  pgliteDir: string,
  agent: Agent,
): Promise<{ agent: Agent; observed: Omit<ModelCase, "events"> }> {
  const chat = chatState(chatId);
  let renders = 0;
  let current = agent;
  for (const event of events) {
    if (event === TASKS) {
      status = STATUSES[renders % STATUSES.length] as string;
      renders += 1;
      await runTasks(current, chatId);
    } else if (event === RESTART) {
      await current.cleanup();
      current = await startAgent(pgliteDir);
    } else if (event === DELETE) {
      // The user deletes the bot's newest board message.
      const newest = chat.posted.at(-1) as number;
      chat.deleted.add(newest);
      if (chat.pinned === newest) chat.pinned = 0;
    }
  }
  const order = (id: number | undefined) =>
    id === undefined ? 0 : chat.posted.indexOf(id) + 1;
  const memory = await current.runtime.getMemoryById(
    stringToUuid(`tg-task-board:${chatId}:`),
  );
  const storedId = (memory?.content as { boardMessageId?: unknown } | undefined)
    ?.boardMessageId;
  return {
    agent: current,
    observed: {
      calls: chat.calls,
      visible: chat.posted
        .filter((id) => !chat.deleted.has(id))
        .map((id) => order(id)),
      stored: typeof storedId === "number" ? order(storedId) : 0,
      pinned: chat.pinned === 0 ? 0 : order(chat.pinned),
      posts: chat.posted.length,
      edits: chat.edits,
    },
  };
}

let chatSeed = -1_008_902_000_000;

it("edits one pinned task board after status changes and a restart", async () => {
  const pgliteDir = mkdtempSync(join(tmpdir(), "telegram-task-board-"));
  let agent = await startAgent(pgliteDir);
  try {
    const chatId = chatSeed--;
    const result = await replay(
      [TASKS, TASKS, RESTART, TASKS],
      chatId,
      pgliteDir,
      agent,
    );
    agent = result.agent;
    expect(result.observed.calls).toEqual([
      "sendMessage",
      "pinChatMessage",
      "editMessageText",
      "editMessageText",
    ]);
    const chat = chatState(chatId);
    expect(chat.posted).toHaveLength(1);
    expect(chat.pinned).toBe(chat.posted[0]);
    // The last `/tasks` edited the first board to the newest status.
    expect(chat.texts.get(chat.posted[0] as number)).toContain(
      "⏳ ship the task board",
    );
  } finally {
    await agent.cleanup();
    rmSync(pgliteDir, { recursive: true, force: true });
  }
}, 120_000);

for (const first of ["tasks", "restart"] as const) {
  it(`task board model replays ${first} first`, async () => {
    const group = cases.filter(
      (item) => item.events[0] === (first === "tasks" ? TASKS : RESTART),
    );
    // Without generated cases only the cases listed above run.
    if (!casesFile && group.length === 0) return;
    expect(group.length).toBeGreaterThan(0);
    const pgliteDir = mkdtempSync(join(tmpdir(), "telegram-task-board-"));
    let agent = await startAgent(pgliteDir);
    try {
      for (const item of group) {
        const result = await replay(item.events, chatSeed--, pgliteDir, agent);
        agent = result.agent;
        const { events, ...expected } = item;
        expect({ events, ...result.observed }).toEqual({ events, ...expected });
      }
    } finally {
      await agent.cleanup();
      rmSync(pgliteDir, { recursive: true, force: true });
    }
  }, 900_000);
}
