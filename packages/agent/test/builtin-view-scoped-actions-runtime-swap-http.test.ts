/** The built-in views' scoped actions are registered on every runtime the API server serves, not only the one present at boot. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startApiServer } from "../src/api/server.ts";

const FILL_BIO = "VIEW_CHARACTER_FILL_BIO";
const apiToken = randomUUID();
let directory: string;
const runtimes: Array<Awaited<ReturnType<typeof createTestRuntime>>> = [];
const servers: Array<Awaited<ReturnType<typeof startApiServer>>> = [];

const savedEnv = new Map<string, string | undefined>();
function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function waitForAction(runtime: IAgentRuntime, name: string) {
  const deadline = Date.now() + 15_000;
  while (!hasAction(runtime, name) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(hasAction(runtime, name)).toBe(true);
}

function hasAction(runtime: IAgentRuntime, name: string): boolean {
  return runtime.actions.some((action) => action.name === name);
}

async function newRuntime(characterName: string) {
  const created = await createTestRuntime({ characterName });
  runtimes.push(created);
  return created.runtime;
}

async function post(port: number, pathname: string) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "eliza-view-scoped-swap-"));
  const configPath = path.join(directory, "eliza.json");
  await writeFile(configPath, JSON.stringify({}));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: configPath,
    ELIZA_PERSIST_CONFIG_PATH: configPath,
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: apiToken,
  }))
    setEnv(key, value);
  for (const key of ["POSTGRES_URL", "DATABASE_URL", "ELIZA_CLOUD_PROVISIONED"])
    setEnv(key, undefined);
}, 120_000);

afterAll(async () => {
  for (const server of servers) await server.close();
  for (const runtime of runtimes) await runtime.cleanup();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
}, 120_000);

it("registers them on the runtime a bind-first host attaches with updateRuntime", async () => {
  // The desktop server-only host and the dev server bind the API before the
  // runtime exists, then hand the booted runtime over with updateRuntime.
  const server = await startApiServer({ port: 0 });
  servers.push(server);
  const runtime = await newRuntime("AttachedLater");

  server.updateRuntime(runtime as never);

  await waitForAction(runtime, FILL_BIO);
}, 120_000);

it("registers them on the runtime /api/agent/start boots after /api/agent/stop", async () => {
  const first = await newRuntime("BeforeStop");
  const replacement = await newRuntime("AfterStart");
  const server = await startApiServer({
    port: 0,
    runtime: first as never,
    onStop: async () => {},
    onRestart: async () => replacement as never,
  });
  servers.push(server);
  await waitForAction(first, FILL_BIO);

  expect((await post(server.port, "/api/agent/stop")).status).toBe(200);
  expect((await post(server.port, "/api/agent/start")).status).toBe(200);

  await waitForAction(replacement, FILL_BIO);
}, 120_000);
