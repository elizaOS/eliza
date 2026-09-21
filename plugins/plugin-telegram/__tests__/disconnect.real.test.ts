/**
 * Exercises saved-bot removal and pending-start admission with real runtimes,
 * persisted connector configuration, and a loopback Telegram API. Only the
 * provider URL is redirected; the runtime registry and Telegram service are real.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteRequest, RouteResponse } from "@elizaos/core";
import { expect, it } from "vitest";
import { ConnectorSetupService } from "../../../packages/agent/src/services/connector-setup-service.ts";
import { createCharacter } from "../../../packages/core/src/character.ts";
import { AgentRuntime } from "../../../packages/core/src/runtime.ts";
import type { UUID } from "../../../packages/core/src/types/index.ts";
import { createDatabaseAdapter } from "../../plugin-inmemorydb/index.ts";
import { getTelegramPollerClaim } from "../src/poller-lock.ts";
import { TelegramService } from "../src/service.ts";
import { telegramSetupRoutes } from "../src/setup-routes.ts";

async function invoke(runtime: AgentRuntime, path: string, body: object) {
  const route = telegramSetupRoutes.find((entry) => entry.path === path);
  if (!route?.handler) throw new Error(`Missing setup route ${path}`);
  let status = 0;
  let payload: unknown;
  const response = {
    status(value: number) {
      status = value;
      return response;
    },
    json(value: unknown) {
      payload = value;
      return response;
    },
  };
  await route.handler(
    { body } as RouteRequest,
    response as RouteResponse,
    runtime,
  );
  return { status, payload };
}

it("removes an unstarted saved bot but fences a real pending service before allowing disconnect", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "telegram-disconnect-"));
  const env = {
    ELIZA_STATE_DIR: stateDir,
    ELIZA_CONFIG_PATH: join(stateDir, "eliza.json"),
    ELIZA_TELEGRAM_STANDALONE_BOT: "0",
  };
  const previous = new Map(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  const token = "123456:SYNTHETIC_LOCAL_ONLY_123456789";
  const originalFetch = globalThis.fetch;
  let releaseStart: (() => void) | undefined;
  let loading: Promise<unknown> | undefined;
  let runtime: AgentRuntime | undefined;
  let resolvePoll!: () => void;
  const polled = new Promise<void>((resolve) => {
    resolvePoll = resolve;
  });
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const method = request.url?.split("/").pop();
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      response.setHeader("content-type", "application/json");
      if (method === "getMe")
        response.end(
          JSON.stringify({
            ok: true,
            result: {
              id: 123456,
              is_bot: true,
              first_name: "Synthetic",
              username: "synthetic_bot",
            },
          }),
        );
      else if (method === "getUpdates" && body.limit !== 1) resolvePoll();
      else if (method === "getUpdates")
        response.end(JSON.stringify({ ok: true, result: [] }));
      else if (method === "deleteWebhook" || method === "setMyCommands")
        response.end(JSON.stringify({ ok: true, result: true }));
      else {
        response.statusCode = 400;
        response.end(
          JSON.stringify({
            ok: false,
            description: `Unexpected synthetic API method ${method}`,
          }),
        );
      }
    });
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Loopback server did not bind");
    const apiRoot = `http://127.0.0.1:${address.port}`;
    globalThis.fetch = ((input, init) => {
      if (String(input) !== `https://api.telegram.org/bot${token}/getMe`)
        throw new Error("Unexpected provider request");
      return originalFetch(`${apiRoot}/bot${token}/getMe`, init);
    }) as typeof fetch;
    const agentId = randomUUID() as UUID;
    runtime = new AgentRuntime({
      agentId,
      adapter: createDatabaseAdapter(agentId),
      enableAutonomy: false,
      logLevel: "fatal",
      character: createCharacter({
        name: "Synthetic saved bot",
        settings: { telegram: { botToken: token, apiRoot } },
      }),
      plugins: [
        {
          name: "setup-only",
          description: "No Telegram service is registered yet",
          services: [ConnectorSetupService],
        },
      ],
    });
    await runtime.initialize();
    const setup = (await runtime.getServiceLoadPromise(
      "connector-setup",
    )) as ConnectorSetupService;
    expect(runtime.hasService("telegram")).toBe(false);
    expect(
      (await invoke(runtime, "/api/setup/telegram/start", { token })).status,
    ).toBe(200);
    expect(setup.getConfig()).toMatchObject({
      connectors: { telegram: { enabled: true, bot: { id: 123456 } } },
    });
    expect(
      await invoke(runtime, "/api/setup/telegram/disconnect", {
        expectedBotId: 123456,
      }),
    ).toMatchObject({ status: 200, payload: { state: "disconnected" } });
    expect(setup.getConfig()).toMatchObject({
      connectors: { telegram: { enabled: false } },
    });

    expect(
      (await invoke(runtime, "/api/setup/telegram/start", { token })).status,
    ).toBe(200);
    let entered!: () => void;
    const startEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const startBarrier = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    class PendingTelegramService extends TelegramService {
      static override async start(
        owner: AgentRuntime,
      ): Promise<TelegramService> {
        entered();
        await startBarrier;
        return TelegramService.start(owner);
      }
    }
    await runtime.registerService(PendingTelegramService);
    loading = runtime.getServiceLoadPromise("telegram");
    await startEntered;
    expect(runtime.hasService("telegram")).toBe(true);
    expect(runtime.getServicesByType("telegram")).toHaveLength(0);
    const before = setup.getConfig();
    expect(
      (
        await invoke(runtime, "/api/setup/telegram/disconnect", {
          expectedBotId: 123456,
        })
      ).status,
    ).toBe(503);
    expect(setup.getConfig()).toEqual(before);
    releaseStart();
    await loading;
    await polled;
    expect(getTelegramPollerClaim(token)?.connected).toBe(true);
    expect(
      await invoke(runtime, "/api/setup/telegram/disconnect", {
        expectedBotId: 123456,
      }),
    ).toMatchObject({ status: 200, payload: { state: "disconnected" } });
    expect(getTelegramPollerClaim(token)).toBeUndefined();
    expect(
      await invoke(runtime, "/api/setup/telegram/status", {}),
    ).toMatchObject({
      status: 200,
      payload: {
        state: "idle",
        detail: { bot: { id: 123456 }, disconnectPending: false },
      },
    });
    let extraEntered!: () => void;
    const extraStarted = new Promise<void>((resolve) => {
      extraEntered = resolve;
    });
    const extraBarrier = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    class AdditionalTelegramService extends TelegramService {
      static override async start(
        owner: AgentRuntime,
      ): Promise<TelegramService> {
        extraEntered();
        await extraBarrier;
        return new TelegramService(owner);
      }
    }
    await runtime.registerService(AdditionalTelegramService);
    loading = runtime.getServiceLoadPromise("telegram");
    await extraStarted;
    expect(runtime.getServicesByType("telegram")).toHaveLength(1);
    const beforeAdditional = setup.getConfig();
    expect(
      (
        await invoke(runtime, "/api/setup/telegram/disconnect", {
          expectedBotId: 123456,
        })
      ).status,
    ).toBe(503);
    expect(setup.getConfig()).toEqual(beforeAdditional);
    releaseStart?.();
    await loading;
    expect(runtime.getServicesByType("telegram")).toHaveLength(2);
  } finally {
    releaseStart?.();
    // error-policy:J6 Settle the owned startup before teardown; the main path observes its rejection.
    if (loading) await Promise.allSettled([loading]);
    const stopping = runtime?.stop();
    server.closeAllConnections();
    await stopping;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});
