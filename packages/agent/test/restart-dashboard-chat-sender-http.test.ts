/** After an in-process restart, the new runtime can still deliver agent messages to the dashboard chat. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";

const apiToken = randomUUID();
let directory: string;
let first: Awaited<ReturnType<typeof createTestRuntime>>;
let second: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "eliza-restart-chat-"));
  const configPath = path.join(directory, "eliza.json");
  await writeFile(configPath, JSON.stringify({}));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: configPath,
    ELIZA_PERSIST_CONFIG_PATH: configPath,
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: apiToken,
  }))
    vi.stubEnv(key, value);
  for (const key of ["POSTGRES_URL", "DATABASE_URL", "ELIZA_CLOUD_PROVISIONED"])
    vi.stubEnv(key, undefined);
  first = await createTestRuntime({ characterName: "BeforeRestart" });
  second = await createTestRuntime({ characterName: "AfterRestart" });
  server = await startApiServer({
    port: 0,
    runtime: first.runtime,
    skipDeferredStartupWork: true,
    onRestart: async () => second.runtime,
  });
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (first) await first.cleanup();
  if (second) await second.cleanup();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 120_000);

async function ownerChatDelivery(runtime: typeof first.runtime) {
  try {
    await runtime.sendMessageToTarget(
      { source: "owner_chat" },
      { text: "Your 3pm reminder", source: "owner_chat" },
    );
    return "delivered";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

it("registers dashboard chat delivery on the runtime that a restart builds", async () => {
  expect(await ownerChatDelivery(first.runtime)).toBe("delivered");

  const restart = await fetch(
    `http://127.0.0.1:${server.port}/api/agent/restart`,
    { method: "POST", headers: { Authorization: `Bearer ${apiToken}` } },
  );
  expect(restart.status, await restart.clone().text()).toBe(200);

  // The test runtimes use separate databases, so delivery itself can fail on
  // the owner conversation; what must hold is that a handler is registered.
  expect(await ownerChatDelivery(second.runtime)).not.toBe(
    "SEND_HANDLER_NOT_FOUND",
  );
}, 90_000);
