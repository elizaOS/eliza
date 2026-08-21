/**
 * Regression test for `TelegramService.start()`'s retry loop.
 *
 * The loop re-runs the whole init sequence on the SAME `Telegraf` instance, but
 * Telegraf registration appends and `startPolling()` overwrites `bot.polling` —
 * so a failure AFTER the poller already connected used to launch a second
 * long-poll loop and strand the first one where `bot.stop()` can never reach it.
 * These tests drive the real `TelegramService` and a real `Telegraf` against a
 * loopback stub of the Bot API, injecting exactly one transient `getMe` failure
 * at the point `start()` awaits it, and assert that stopping the service really
 * stops polling.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { TelegramService } from "./service";

const servers: http.Server[] = [];
const services: TelegramService[] = [];

afterEach(async () => {
  await Promise.all(services.map((service) => service.stop().catch(() => {})));
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
});

interface StubBotApi {
  apiRoot: string;
  getMeCalls: () => number;
  getUpdatesCalls: () => number;
}

/**
 * Minimal Bot API over loopback. `failGetMeAt` is a 1-based call index: call 3
 * is the `await state.bot.telegram.getMe()` that `start()` performs after
 * `initializeBot` has already launched the poller (1 = inside `bot.launch`,
 * 2 = the bot-info log line).
 */
async function startStubBotApi(failGetMeAt?: number): Promise<StubBotApi> {
  let getMeCalls = 0;
  let getUpdatesCalls = 0;
  const server = http.createServer((req, res) => {
    const method = (req.url ?? "").split("/").pop() ?? "";
    req.resume();
    req.on("end", () => {
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
        // Answer quickly so the loop spins visibly instead of long-polling.
        setTimeout(() => res.end(JSON.stringify({ ok: true, result: [] })), 20);
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
  };
}

function makeRuntime(apiRoot: string): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-0000000000a1",
    character: {
      name: "Agent One",
      settings: { telegram: { botToken: "123456:STUB", apiRoot } },
    },
    getSetting: () => undefined,
    getService: () => null,
    getServicesByType: () => [],
    registerMessageConnector: () => {},
    registerSendHandler: () => {},
    emitEvent: () => {},
    reportError: () => {},
    getRoom: async () => null,
    getMemories: async () => [],
    getEntityById: async () => null,
    createMemory: async () => {},
    ensureConnection: async () => {},
    actions: [],
    providers: [],
    evaluators: [],
  } as unknown as IAgentRuntime;
}

function accountBot(service: TelegramService): {
  polling?: { abortController: { signal: { aborted: boolean } } };
} {
  const states = (
    service as unknown as {
      accountStates: Map<string, { bot: { polling?: never } }>;
    }
  ).accountStates;
  return states.get("default")?.bot as never;
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("TelegramService.start retry does not strand a long-poll loop", () => {
  it("stops polling on stop() after a transient failure retried the init sequence", async () => {
    // getMe #3 is the one start() awaits after initializeBot has already
    // launched the poller — the failure that used to trigger a second launch.
    const api = await startStubBotApi(3);
    const service = await TelegramService.start(makeRuntime(api.apiRoot));
    services.push(service);
    await settle(300);

    // The retry really happened (initial 3 + the retry's 2 more).
    expect(api.getMeCalls()).toBeGreaterThan(3);
    const bot = accountBot(service);
    expect(bot.polling?.abortController.signal.aborted).toBe(false);

    await service.stop();
    services.length = 0;
    const before = api.getUpdatesCalls();
    await settle(800);
    // At most the one request that was already in flight may still land.
    expect(api.getUpdatesCalls() - before).toBeLessThanOrEqual(1);
  });

  it("stops polling on stop() with no failure at all (unchanged happy path)", async () => {
    const api = await startStubBotApi();
    const service = await TelegramService.start(makeRuntime(api.apiRoot));
    services.push(service);
    await settle(300);

    expect(api.getMeCalls()).toBe(3);
    const bot = accountBot(service);
    expect(bot.polling?.abortController.signal.aborted).toBe(false);

    await service.stop();
    services.length = 0;
    const before = api.getUpdatesCalls();
    await settle(800);
    expect(api.getUpdatesCalls() - before).toBeLessThanOrEqual(1);
  });
});
