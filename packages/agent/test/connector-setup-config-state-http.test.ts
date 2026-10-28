/** Real setup-panel writes stay in the live API config across later settings saves. */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHttpPluginRoutes } from "@elizaos/host/protocol";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { telegramSetupRoutes } from "../../../plugins/plugin-telegram/src/setup-routes.ts";
import { startApiServer } from "../src/api/server.ts";
import { ConnectorSetupService } from "../src/services/connector-setup-service.ts";

const apiToken = randomUUID();
const fakeBotToken = "123456:FAKE_TEST_TOKEN_NOT_A_REAL_BOT_TOKEN";
let directory: string;
let configPath: string;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "eliza-connector-setup-"));
  configPath = path.join(directory, "eliza.json");
  await writeFile(configPath, JSON.stringify({ ui: { theme: "light" } }));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: configPath,
    ELIZA_PERSIST_CONFIG_PATH: configPath,
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: apiToken,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
  }))
    vi.stubEnv(key, value);
  for (const key of ["POSTGRES_URL", "DATABASE_URL", "ELIZA_CLOUD_PROVISIONED"])
    vi.stubEnv(key, undefined);
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://api.telegram.org/")) {
        return Response.json({
          ok: true,
          result: { id: 123456, username: "fake_test_bot", first_name: "Fake" },
        });
      }
      return realFetch(input, init);
    },
  );
  fixture = await createTestRuntime({
    characterName: "ConnectorSetupConfigState",
  });
  await fixture.runtime.registerService(ConnectorSetupService);
  registerHttpPluginRoutes(fixture.runtime, {
    name: "telegram-setup",
    description: "Telegram setup panel routes",
    routes: telegramSetupRoutes,
  });
  server = await startApiServer({
    port: 0,
    runtime: fixture.runtime,
    skipDeferredStartupWork: true,
  });
  await fixture.runtime.getServiceLoadPromise("connector-setup");
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (fixture) await fixture.cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 120_000);

function call(method: string, route: string, body?: unknown) {
  return fetch(`http://127.0.0.1:${server.port}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function persistedConfig() {
  return JSON.parse(await readFile(configPath, "utf8")) as {
    connectors?: { telegram?: Record<string, unknown> };
    ui?: Record<string, unknown>;
    agents?: { defaults?: { escalation?: { channels?: string[] } } };
  };
}

it("keeps the Telegram token saved from the setup panel when settings are saved afterwards", async () => {
  const start = await call("POST", "/api/setup/telegram/start", {
    token: fakeBotToken,
  });
  expect(start.status, await start.clone().text()).toBe(200);
  expect((await persistedConfig()).connectors?.telegram?.botToken).toBe(
    fakeBotToken,
  );

  // Setup also registers Telegram as an escalation channel for the owner.
  expect(
    (await persistedConfig()).agents?.defaults?.escalation?.channels ?? [],
  ).toContain("telegram");

  const settings = await call("PUT", "/api/config", { ui: { theme: "dark" } });
  expect(settings.status, await settings.clone().text()).toBe(200);

  const saved = await persistedConfig();
  expect(saved.ui?.theme).toBe("dark");
  expect(saved.agents?.defaults?.escalation?.channels ?? []).toContain(
    "telegram",
  );
  expect(saved.connectors?.telegram).toMatchObject({
    botToken: fakeBotToken,
    enabled: true,
    bot: { id: 123456, username: "fake_test_bot", firstName: "Fake" },
  });

  const config = (await (await call("GET", "/api/config")).json()) as {
    connectors?: { telegram?: Record<string, unknown> };
  };
  expect(config.connectors?.telegram?.enabled).toBe(true);
}, 120_000);
