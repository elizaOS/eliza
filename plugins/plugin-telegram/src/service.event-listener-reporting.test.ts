/**
 * Event listeners are observers. A listener that rejects must be reported
 * through `runtime.reportError`. A floating `emitEvent` call leaves an
 * unhandled rejection that can stop the bot process.
 */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { TelegramService } from "./service";

// The /start handler registers the task-board command on the same bot. Keep
// that registration out of this case so the test does not start its timers.
vi.mock("./task-board", () => ({
  registerTelegramTaskBoardCommand: () => ({}),
}));

const AGENT_ID = "00000000-0000-4000-8000-0000000000a1";

function createRuntime() {
  return {
    agentId: AGENT_ID,
    emitEvent: vi.fn(async () => {
      throw new Error("listener boom");
    }),
    reportError: vi.fn(),
    registerEvent: vi.fn(),
    getService: () => null,
    getSetting: () => undefined,
    ensureConnection: vi.fn(async () => undefined),
    getEntityById: vi.fn(async () => null),
  } as unknown as IAgentRuntime;
}

function createService(runtime: IAgentRuntime) {
  const service = Object.create(TelegramService.prototype) as TelegramService;
  Object.assign(service, {
    runtime,
    defaultAccountId: "default",
    syncedEntityIds: new Set<string>(),
    accountStates: new Map(),
  });
  return service;
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

it("reports a rejected /start event listener", async () => {
  const runtime = createRuntime();
  const service = createService(runtime);
  let startHandler: ((ctx: unknown) => void) | undefined;
  const bot = {
    start: (handler: (ctx: unknown) => void) => {
      startHandler = handler;
    },
    command: () => undefined,
  };

  (
    service as unknown as {
      registerBotCommands: (
        bot: unknown,
        activeState: unknown,
        accountId: string,
      ) => void;
    }
  ).registerBotCommands(bot, { messageManager: {} }, "default");

  expect(startHandler).toBeDefined();
  startHandler?.({ chat: { id: 1 }, from: { id: 42 } });
  await settle();

  expect(
    vi.mocked(runtime.reportError).mock.calls.map(([scope]) => scope),
  ).toEqual(["TelegramService.emitSlashStart"]);
});

it("reports a rejected entity-joined event listener", async () => {
  const runtime = createRuntime();
  const service = createService(runtime);

  await (
    service as unknown as {
      syncNewChatMember: (
        ctx: unknown,
        worldId: UUID,
        roomId: UUID,
        chatId: string,
        accountId: string,
      ) => Promise<void>;
    }
  ).syncNewChatMember(
    {
      chat: { id: -1001234567890, type: "supergroup", title: "Team" },
      message: { new_chat_members: [{ id: 99, first_name: "Ann" }] },
    },
    "00000000-0000-4000-8000-0000000000b1" as UUID,
    "00000000-0000-4000-8000-0000000000b2" as UUID,
    "-1001234567890",
    "default",
  );
  await settle();

  expect(
    vi.mocked(runtime.reportError).mock.calls.map(([scope]) => scope),
  ).toEqual(["TelegramService.emitEntityJoined"]);
});
