import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "@elizaos/agent/api/server";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  createAndroidAgentExecutor,
  createAndroidAgentFetch,
} from "../mobile-remote-target";

let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;
let directory: string;
const token = randomUUID();
const owner = "f4350000-0000-4000-8000-000000000099";
const observations: Array<{
  path: string;
  execution: string | undefined;
  authorization: string | undefined;
}> = [];
let hold = false;
let entered: () => void = () => {};
let release: () => void = () => {};
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "android-direct-kernel-"));
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  vi.stubEnv("ELIZA_CONFIG_PATH", join(directory, "eliza.json"));
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", join(directory, "eliza.json"));
  vi.stubEnv("ELIZA_API_TOKEN", token);
  vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", "1");
  vi.stubEnv("ELIZA_CLOUD_PROVISIONED", undefined);
  fixture = await createTestRuntime({
    characterName: "AndroidDirectKernel",
    settings: { LOAD_DOCS_ON_STARTUP: false, ELIZA_ADMIN_ENTITY_ID: owner },
  });
  server = await startApiServer({
    runtime: fixture.runtime,
    skipListen: true,
    skipDeferredStartupWork: true,
    requestMiddleware: async (req, res, next) => {
      observations.push({
        path: req.url ?? "",
        execution: req.headers["x-eliza-remote-execution-id"] as
          | string
          | undefined,
        authorization: req.headers.authorization,
      });
      if (hold && req.url === "/api/health") {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        res.setHeader("content-type", "application/json");
        res.end('{"status":"ready"}');
        return;
      }
      await next();
    },
  });
}, 120000);
afterAll(async () => {
  release();
  if (server) await server.close();
  if (fixture) await fixture.cleanup();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 120000);
it("dispatches through initialized full kernel with unchanged execution and bearer", async () => {
  const executor = await createAndroidAgentExecutor(fixture.runtime);
  const result = await executor.execute({
    action: "agent.status",
    payload: {},
    executionId: "direct-owner-one",
  });
  expect(result.status).toBe("completed");
  expect(result.result).toMatchObject({ status: 200 });
  expect(
    observations.some(
      (row) =>
        row.path === "/api/health" &&
        row.execution === "direct-owner-one" &&
        row.authorization === `Bearer ${token}`,
    ),
  ).toBe(true);
});
it("rejects nonallowlisted path before kernel dispatch", async () => {
  const executor = await createAndroidAgentExecutor(fixture.runtime);
  const before = observations.length;
  expect(
    (
      await executor.execute({
        action: "agent.request",
        payload: { method: "GET", path: "/api/config" },
        executionId: "forbidden",
      })
    ).status,
  ).toBe("rejected");
  expect(observations.length).toBe(before);
});
it("rejects a stale bearer on a protected route after configured token rotation", async () => {
  const executor = await createAndroidAgentExecutor(fixture.runtime);
  vi.stubEnv("ELIZA_API_TOKEN", randomUUID());
  try {
    const result = await executor.execute({
      // Health is public in the full kernel; use an owner-protected route.
      action: "agent.request",
      payload: {
        method: "POST",
        path: "/api/conversations",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Denied stale owner",
          includeGreeting: false,
        }),
      },
      executionId: "stale-owner",
    });
    expect(result.status).toBe("completed");
    expect(result.result).toMatchObject({ status: 401 });
  } finally {
    vi.stubEnv("ELIZA_API_TOKEN", token);
  }
});
it("bounds an admitted pending dispatch and does not replay its late completion", async () => {
  const executor = await createAndroidAgentExecutor(fixture.runtime);
  hold = true;
  const witness = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const completion = executor.execute({
    action: "agent.status",
    payload: {},
    executionId: "held-once",
  });
  const outcome = completion.then(
    () => ({ rejected: false }),
    () => ({ rejected: true }),
  );
  try {
    await witness;
    const result = await outcome;
    expect(result.rejected).toBe(true);
    expect(
      observations.filter((row) => row.execution === "held-once"),
    ).toHaveLength(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      observations.filter((row) => row.execution === "held-once"),
    ).toHaveLength(1);
  } finally {
    hold = false;
    release();
  }
}, 15000);
it("retains conversation identity through create and read on the real kernel", async () => {
  const executor = await createAndroidAgentExecutor(fixture.runtime);
  const created = await executor.execute({
    action: "agent.request",
    payload: {
      method: "POST",
      path: "/api/conversations",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Direct owner acceptance",
        includeGreeting: false,
      }),
    },
    executionId: "owner-create",
  });
  expect(created.status).toBe("completed");
  expect(created.result).toMatchObject({ status: 200 });
  const body = (created.result as { body: string }).body;
  const conversation = JSON.parse(body).conversation;
  expect(conversation.id).toEqual(expect.any(String));
  const room = await fixture.runtime.getRoom(conversation.roomId);
  expect(room).toBeDefined();
  if (!room?.worldId)
    throw new Error("Created conversation has no owner world");
  const world = await fixture.runtime.getWorld(room.worldId);
  expect(world?.metadata?.ownership).toMatchObject({ ownerId: owner });
  const read = await executor.execute({
    action: "agent.request",
    payload: {
      method: "GET",
      path: `/api/conversations/${conversation.id}/messages`,
      headers: {},
    },
    executionId: "owner-read",
  });
  expect(read.status).toBe("completed");
  expect(read.result).toMatchObject({ status: 200 });
  expect(JSON.parse((read.result as { body: string }).body).messages).toEqual(
    [],
  );
  expect(
    observations.filter((row) => row.execution === "owner-create"),
  ).toHaveLength(1);
  expect(
    observations.filter((row) => row.execution === "owner-read"),
  ).toHaveLength(1);
});

it("pre-aborted request never reaches the initialized kernel", async () => {
  const fetch = await createAndroidAgentFetch(fixture.runtime);
  const controller = new AbortController();
  const reason = new Error("controlled predispatch cancellation");
  controller.abort(reason);
  const count = observations.length;
  await expect(
    fetch("http://127.0.0.1/api/health", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    }),
  ).rejects.toBe(reason);
  expect(observations.length).toBe(count);
});
