/**
 * Integration-backed regressions for `TelegramService` startup retries.
 *
 * The tests run the real service and Telegraf poller against a loopback Bot API.
 * The stub holds long polls open, so request arrival and abort events provide
 * deterministic lifecycle boundaries without wall-clock sampling windows.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { Telegraf } from "telegraf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTelegramCommandDescriptors } from "./command-registration";
import { MessageManager } from "./messageManager";
import { TelegramService } from "./service";

const TEST_DEADLINE_MS = 5_000;
const servers: http.Server[] = [];
const services: TelegramService[] = [];
let signalListenersBefore: Record<
  "SIGINT" | "SIGTERM",
  ReturnType<typeof process.rawListeners>
>;

beforeEach(() => {
  signalListenersBefore = {
    SIGINT: process.rawListeners("SIGINT"),
    SIGTERM: process.rawListeners("SIGTERM"),
  };
});

afterEach(async () => {
  // error-policy:J6 Teardown failures are collected so every resource is reclaimed, then
  // surfaced after cleanup instead of being silently swallowed.
  const stopResults = await Promise.allSettled(
    services.map((service) => service.stop()),
  );
  services.length = 0;
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
  servers.length = 0;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const listener of process.rawListeners(signal)) {
      if (!signalListenersBefore[signal].includes(listener)) {
        process.removeListener(signal, listener as NodeJS.SignalsListener);
      }
    }
  }
  vi.restoreAllMocks();
  const stopErrors = stopResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (stopErrors.length > 0) {
    throw new AggregateError(stopErrors, "Telegram service teardown failed");
  }
});

interface StubBotApi {
  apiRoot: string;
  getMeCalls: () => number;
  getUpdatesCalls: () => number;
  activeGetUpdates: () => number;
  deliverUpdate: (update: Record<string, unknown>) => Promise<void>;
  waitForActiveGetUpdates: (expected: number) => Promise<void>;
  waitForGetUpdatesCalls: (expected: number) => Promise<void>;
}

function deadline<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${message} within ${TEST_DEADLINE_MS}ms`)),
      TEST_DEADLINE_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Minimal Bot API over loopback. `failGetMeAt` is a 1-based call index: call 3
 * is the `await state.bot.telegram.getMe()` that `start()` performs after
 * startup wiring has already launched the poller.
 */
async function startStubBotApi(failGetMeAt?: number): Promise<StubBotApi> {
  let getMeCalls = 0;
  let getUpdatesCalls = 0;
  let nextRequestId = 0;
  const pendingUpdates = new Map<number, http.ServerResponse>();
  const stateWaiters = new Set<() => void>();
  const notifyState = () => {
    for (const waiter of stateWaiters) waiter();
  };
  const waitForState = (predicate: () => boolean, message: string) => {
    if (predicate()) return Promise.resolve();
    return deadline(
      new Promise<void>((resolve) => {
        const waiter = () => {
          if (!predicate()) return;
          stateWaiters.delete(waiter);
          resolve();
        };
        stateWaiters.add(waiter);
      }),
      message,
    );
  };

  const server = http.createServer((req, res) => {
    const method = (req.url ?? "").split("/").pop() ?? "";
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      res.setHeader("content-type", "application/json");
      if (method === "getMe") {
        getMeCalls += 1;
        if (getMeCalls === failGetMeAt) {
          res.statusCode = 500;
          res.end(
            JSON.stringify({
              ok: false,
              error_code: 500,
              description: "Internal Server Error",
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              id: 1,
              is_bot: true,
              first_name: "stub",
              username: "stub_bot",
            },
          }),
        );
        return;
      }
      if (method === "getUpdates") {
        getUpdatesCalls += 1;
        notifyState();
        // Telegraf performs this un-aborted offset-sync request after the main
        // poll is aborted. Complete it immediately so terminal poller state is
        // observable from active long-poll request count alone.
        if (payload.limit === 1) {
          res.end(JSON.stringify({ ok: true, result: [] }));
          return;
        }
        const requestId = ++nextRequestId;
        pendingUpdates.set(requestId, res);
        let finalized = false;
        const finalize = () => {
          if (finalized) return;
          finalized = true;
          pendingUpdates.delete(requestId);
          notifyState();
        };
        req.once("aborted", finalize);
        res.once("close", finalize);
        res.socket?.once("close", finalize);
        notifyState();
        return;
      }
      res.end(JSON.stringify({ ok: true, result: true }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    apiRoot: `http://127.0.0.1:${port}`,
    getMeCalls: () => getMeCalls,
    getUpdatesCalls: () => getUpdatesCalls,
    activeGetUpdates: () => pendingUpdates.size,
    waitForActiveGetUpdates: (expected) =>
      waitForState(
        () => pendingUpdates.size === expected,
        `Expected ${expected} active getUpdates requests`,
      ),
    waitForGetUpdatesCalls: (expected) =>
      waitForState(
        () => getUpdatesCalls === expected,
        `Expected ${expected} getUpdates calls`,
      ),
    deliverUpdate: async (update) => {
      await waitForState(
        () => pendingUpdates.size > 0,
        "Expected a pending getUpdates request",
      );
      const [requestId, response] = pendingUpdates.entries().next().value as [
        number,
        http.ServerResponse,
      ];
      pendingUpdates.delete(requestId);
      response.end(JSON.stringify({ ok: true, result: [update] }));
      notifyState();
    },
  };
}

function makeRuntime(apiRoot: string): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-0000000000a1",
    character: {
      name: "Agent One",
      settings: { telegram: { botToken: "123456:STUB", apiRoot } },
    },
    getSetting: (key: string) =>
      key === "TELEGRAM_DM_POLICY" ? "open" : undefined,
    getService: () => null,
    getServicesByType: () => [],
    registerMessageConnector: () => {},
    registerSendHandler: () => {},
    emitEvent: () => {},
    reportError: () => {},
    getRoom: async () => null,
    getWorld: async () => null,
    getMemories: async () => [],
    getEntityById: async () => null,
    createMemory: async () => {},
    ensureConnection: async () => {},
    ensureRoomExists: async () => {},
    ensureWorldExists: async () => {},
    actions: [],
    providers: [],
    evaluators: [],
  } as unknown as IAgentRuntime;
}

type TestAccountState = {
  bot: Telegraf;
  messageManager: { handleMessage: (...args: unknown[]) => Promise<void> };
  wiring: {
    commands: boolean;
    poller: boolean;
    handlers: boolean;
    shutdownHooks: boolean;
  };
};

function accountState(service: TelegramService): TestAccountState {
  const states = (
    service as unknown as {
      accountStates: Map<string, TestAccountState>;
    }
  ).accountStates;
  const state = states.get("default");
  if (!state) throw new Error("Default Telegram account state is missing");
  return state;
}

function initializeBot(
  service: TelegramService,
  state?: TestAccountState,
): Promise<void> {
  return (
    service as unknown as {
      initializeBot: (state?: TestAccountState) => Promise<void>;
    }
  ).initializeBot(state);
}

describe("TelegramService startup wiring", () => {
  it("installs shutdown hooks only after Telegraf assigns a stoppable poller", async () => {
    const api = await startStubBotApi();
    const startPolling = vi.spyOn(Telegraf.prototype, "startPolling");
    const processOnce = vi.spyOn(process, "once");

    const service = await TelegramService.start(makeRuntime(api.apiRoot));
    services.push(service);
    const polling = accountState(service).bot.polling;
    const pollingCallOrder = startPolling.mock.invocationCallOrder[0];
    const signalHookCallOrders = processOnce.mock.calls.flatMap(
      ([event], index) =>
        event === "SIGINT" || event === "SIGTERM"
          ? [processOnce.mock.invocationCallOrder[index]]
          : [],
    );

    expect(polling?.stop).toBeTypeOf("function");
    expect(signalHookCallOrders).toHaveLength(2);
    expect(
      signalHookCallOrders.every((order) => order > pollingCallOrder),
    ).toBe(true);
  });

  it("handles updates while retrying a post-launch startup probe", async () => {
    const api = await startStubBotApi(2);
    const handleMessage = vi
      .spyOn(MessageManager.prototype, "handleMessage")
      .mockResolvedValue(undefined);

    const startPromise = TelegramService.start(makeRuntime(api.apiRoot));
    await api.waitForActiveGetUpdates(1);
    await api.deliverUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        text: "arrived during retry backoff",
        chat: { id: 42, type: "private", first_name: "Test" },
        from: { id: 7, is_bot: false, first_name: "Sender" },
      },
    });
    await api.waitForGetUpdatesCalls(2);

    const service = await startPromise;
    services.push(service);
    expect(api.getMeCalls()).toBe(4);
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it("registers commands, handlers, and shutdown hooks once across an injected retry", async () => {
    const api = await startStubBotApi(3);
    const runtime = makeRuntime(api.apiRoot);
    const startRegistration = vi.spyOn(Telegraf.prototype, "start");
    const commandRegistration = vi.spyOn(Telegraf.prototype, "command");
    const middlewareRegistration = vi.spyOn(Telegraf.prototype, "use");
    const eventRegistration = vi.spyOn(Telegraf.prototype, "on");
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");

    const service = await TelegramService.start(runtime);
    services.push(service);
    const state = accountState(service);
    const handled = Promise.withResolvers<void>();
    const handleMessage = vi
      .spyOn(state.messageManager, "handleMessage")
      .mockImplementation(async () => handled.resolve());
    (
      service as unknown as { knownChats: Map<string, Record<string, unknown>> }
    ).knownChats.set("42", { id: 42, type: "private", first_name: "Test" });

    await api.waitForActiveGetUpdates(1);
    await api.deliverUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        text: "hello",
        chat: { id: 42, type: "private", first_name: "Test" },
        from: { id: 7, is_bot: false, first_name: "Sender" },
      },
    });
    await deadline(handled.promise, "Expected the message handler to run");

    expect(api.getMeCalls()).toBe(5);
    expect(startRegistration).toHaveBeenCalledTimes(1);
    expect(commandRegistration).toHaveBeenCalledTimes(
      buildTelegramCommandDescriptors(runtime.agentId).length + 3,
    );
    expect(middlewareRegistration).toHaveBeenCalledTimes(
      commandRegistration.mock.calls.length +
        eventRegistration.mock.calls.length +
        2,
    );
    expect(eventRegistration).toHaveBeenCalledTimes(3);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(process.listenerCount("SIGINT") - sigintBefore).toBe(1);
    expect(process.listenerCount("SIGTERM") - sigtermBefore).toBe(1);
  });

  it("completes all four one-shot wiring steps inside initializeBot", async () => {
    const api = await startStubBotApi();
    const service = new TelegramService(makeRuntime(api.apiRoot));
    services.push(service);
    const state = accountState(service);

    await initializeBot(service, state);

    expect(state.wiring).toEqual({
      commands: true,
      poller: true,
      handlers: true,
      shutdownHooks: true,
    });
  });

  it("fails fast with a typed error when initializeBot has no account state", async () => {
    const api = await startStubBotApi();
    const service = new TelegramService(makeRuntime(api.apiRoot));
    services.push(service);
    (
      service as unknown as { accountStates: Map<string, TestAccountState> }
    ).accountStates.clear();

    await expect(initializeBot(service)).rejects.toMatchObject({
      name: "ElizaError",
      code: "TELEGRAM_ACCOUNT_STATE_MISSING",
    });
    expect(api.getMeCalls()).toBe(0);
    expect(api.getUpdatesCalls()).toBe(0);
  });
});

describe("TelegramService poller lifecycle", () => {
  it("stops polling after a transient failure retries startup", async () => {
    const api = await startStubBotApi(3);
    const service = await TelegramService.start(makeRuntime(api.apiRoot));
    services.push(service);
    await api.waitForActiveGetUpdates(1);

    expect(api.getMeCalls()).toBe(5);
    expect(api.activeGetUpdates()).toBe(1);

    await service.stop();
    services.length = 0;
    await api.waitForActiveGetUpdates(0);
    await api.waitForGetUpdatesCalls(2);
    expect(api.activeGetUpdates()).toBe(0);
    expect(api.getUpdatesCalls()).toBe(2);
  });

  it("stops polling on the unchanged happy path", async () => {
    const api = await startStubBotApi();
    const service = await TelegramService.start(makeRuntime(api.apiRoot));
    services.push(service);
    await api.waitForActiveGetUpdates(1);

    expect(api.getMeCalls()).toBe(3);
    expect(api.activeGetUpdates()).toBe(1);

    await service.stop();
    services.length = 0;
    await api.waitForActiveGetUpdates(0);
    await api.waitForGetUpdatesCalls(2);
    expect(api.activeGetUpdates()).toBe(0);
    expect(api.getUpdatesCalls()).toBe(2);
  });
});
