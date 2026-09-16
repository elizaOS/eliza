/**
 * Exercises device adoption through the real UI client, authenticated HTTP host,
 * config writer, and server reopen. A registered deterministic model supplies
 * capability admission only; these cases do not claim live inference evidence.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime, ModelType } from "@elizaos/core";
import { ElizaClient } from "@elizaos/ui/api/client";
import { completeRemoteAgentFirstRun } from "@elizaos/ui/first-run/adopt-remote-first-run";
import { setPendingFirstRunTextReleaseHandler } from "@elizaos/ui/first-run/first-run-pending-text";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startApiServer } from "./server.ts";

const token = "synthetic-remote-adoption-owner";
const envKeys = [
  "ELIZA_STATE_DIR",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_API_BIND_HOST",
  "ELIZA_API_TOKEN",
  "ELIZA_API_AUTH_TOKEN",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_PLATFORM",
  "ELIZA_DEVICE_BRIDGE_ENABLED",
] as const;
const savedEnv = new Map<string, string | undefined>();
let directory: string;
let configPath: string;
let runtime: AgentRuntime | undefined;
let api: Awaited<ReturnType<typeof startApiServer>> | undefined;
const requests: string[] = [];
const effects: string[] = [];

beforeEach(async () => {
  for (const key of envKeys) savedEnv.set(key, process.env[key]);
  directory = await mkdtemp(path.join(tmpdir(), "eliza-remote-adoption-"));
  configPath = path.join(directory, "eliza.json");
  process.env.ELIZA_STATE_DIR = directory;
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
  process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
  process.env.ELIZA_API_TOKEN = token;
  process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
  for (const key of [
    "ELIZA_API_AUTH_TOKEN",
    "ELIZA_CLOUD_PROVISIONED",
    "ELIZA_PLATFORM",
    "ELIZA_DEVICE_BRIDGE_ENABLED",
  ])
    delete process.env[key];
  await writeFile(
    configPath,
    JSON.stringify({
      meta: { firstRunComplete: false },
      logging: { level: "error" },
      deploymentTarget: { runtime: "local" },
      serviceRouting: {
        llmText: {
          backend: "elizacloud",
          transport: "cloud-proxy",
          accountId: "elizacloud",
        },
      },
      linkedAccounts: { elizacloud: { status: "linked", source: "oauth" } },
      cloud: { apiKey: "synthetic-host-credential" },
      ui: { language: "en", assistant: { name: "Adoption host" } },
    }),
  );
  requests.length = 0;
  effects.length = 0;
  setPendingFirstRunTextReleaseHandler(() => {
    effects.push("release");
  });
});

afterEach(async () => {
  setPendingFirstRunTextReleaseHandler(null);
  await api?.close();
  api = undefined;
  await runtime?.stop({ fast: true });
  await runtime?.close();
  runtime = undefined;
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
}, 30_000);

async function start(ready: boolean) {
  if (ready && !runtime) {
    runtime = new AgentRuntime({ logLevel: "fatal", plugins: [] });
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () => "deterministic capability fixture",
      "adoption-test",
    );
  }
  api = await startApiServer({
    port: 0,
    runtime,
    skipDeferredStartupWork: true,
    requestMiddleware: async (req, _res, next) => {
      requests.push(`${req.method} ${req.url}`);
      await next();
    },
  });
  return new ElizaClient(`http://127.0.0.1:${api.port}`, token);
}

function adopt(client: ElizaClient) {
  return completeRemoteAgentFirstRun(
    client,
    { apiBase: client.getBaseUrl(), token: "synthetic-device-input" },
    () => {
      effects.push("complete");
    },
  );
}

it("preserves host configuration across adoption and a fresh server, then replays without writing", async () => {
  const client = await start(true);
  expect(await client.getFirstRunStatus()).toEqual({ complete: false });
  const before = JSON.parse(await readFile(configPath, "utf8"));
  requests.length = 0;
  expect(await adopt(client)).toEqual({ alreadyComplete: false });
  expect(requests).toEqual([
    "GET /api/first-run/status",
    "GET /api/status",
    "PUT /api/config",
    "GET /api/first-run/status",
  ]);
  expect(effects).toEqual(["complete", "release"]);
  expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
    ...before,
    meta: { ...before.meta, firstRunComplete: true },
  });
  await api?.close();
  api = undefined;
  const restarted = await start(true);
  const persisted = await readFile(configPath, "utf8");
  requests.length = 0;
  expect(await adopt(restarted)).toEqual({ alreadyComplete: true });
  expect(requests).toEqual(["GET /api/first-run/status"]);
  expect(await readFile(configPath, "utf8")).toBe(persisted);
}, 60_000);

it("rejects an unauthorized device before mutation or local completion", async () => {
  const client = await start(true);
  const before = await readFile(configPath, "utf8");
  client.setToken("synthetic-invalid-token");
  await expect(adopt(client)).rejects.toMatchObject({ status: 401 });
  expect(requests).toEqual(["GET /api/first-run/status"]);
  expect(effects).toEqual([]);
  expect(await readFile(configPath, "utf8")).toBe(before);
}, 60_000);

it("keeps a host without a running runtime in explicit setup", async () => {
  const client = await start(false);
  const before = await readFile(configPath, "utf8");
  await expect(adopt(client)).rejects.toMatchObject({
    code: "REMOTE_ADOPTION_HOST_NOT_READY",
  });
  expect(requests).toEqual(["GET /api/first-run/status", "GET /api/status"]);
  expect(effects).toEqual([]);
  expect(await readFile(configPath, "utf8")).toBe(before);
}, 60_000);
