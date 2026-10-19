/**
 * A restart requested while a start is still booting must not build a
 * second runtime: both use the host's onRestart, and two concurrent builds
 * activate two runtimes with neither disposed. Real API server and routes;
 * onRestart is a delayed stand-in for the host boot.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startApiServer } from "../src/api/server.ts";

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
async function newRuntime(characterName: string) {
  const created = await createTestRuntime({ characterName });
  runtimes.push(created);
  return created.runtime;
}
async function call(port: number, method: string, pathname: string) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    ...(method === "GET" ? {} : { body: "{}" }),
  });
}
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "eliza-restart-during-start-"));
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

it("refuses a restart while a start is booting and builds one runtime", async () => {
  const first = await newRuntime("BeforeStop");
  const booted = await newRuntime("BootA");
  let builds = 0;
  const activated: string[] = [];
  const server = await startApiServer({
    port: 0,
    runtime: first as never,
    onStop: async () => {},
    onRestart: async () => {
      builds += 1;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return booted as never;
    },
    onRuntimeActivated: async (_previous: unknown, next: unknown) => {
      activated.push((next as { character: { name: string } }).character.name);
    },
  } as never);
  servers.push(server);
  expect((await call(server.port, "POST", "/api/agent/stop")).status).toBe(200);

  const start = call(server.port, "POST", "/api/agent/start");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const restart = await call(server.port, "POST", "/api/agent/restart");
  expect(restart.status).toBe(409);
  expect((await start).status).toBe(200);

  expect(builds).toBe(1);
  expect(activated).toEqual(["BootA"]);
  const status = (await (
    await call(server.port, "GET", "/api/status")
  ).json()) as {
    agentName?: string;
    state?: string;
  };
  expect(status).toMatchObject({ agentName: "BootA", state: "running" });
}, 120_000);
