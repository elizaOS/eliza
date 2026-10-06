/** Real Node HTTP boundary for owner-only prompt triggers and the legacy feed. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Memory,
  resolveOwnerEntityIdOrDefault,
  type State,
} from "@elizaos/core";
import { registerHttpPluginRoutes } from "@elizaos/host/protocol";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { workflowRoutePlugin } from "../../../plugins/plugin-workflow/src/plugin-routes.ts";
import { registerTokenRoleResolver } from "../src/api/boundary-role-resolver.ts";
import { startApiServer } from "../src/api/server.ts";
import { createOngoingTasksProvider } from "../src/providers/tasks.ts";
import { readTriggerConfig } from "../src/triggers/runtime.ts";

let canonicalOwner: string;
const foreignOwner = "00000000-0000-4000-8000-000000000022";
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;
let unregisterResolver: (() => void) | undefined;
let stateDir: string;

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "eliza-prompt-owner-http-"));
  await writeFile(path.join(stateDir, "eliza.json"), "{}");
  vi.stubEnv("ELIZA_STATE_DIR", stateDir);
  vi.stubEnv("ELIZA_CONFIG_PATH", path.join(stateDir, "eliza.json"));
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", path.join(stateDir, "eliza.json"));
  vi.stubEnv("ELIZA_API_BIND_HOST", "127.0.0.1");
  vi.stubEnv("ELIZA_CLOUD_PROVISIONED", undefined);
  fixture = await createTestRuntime({ characterName: "PromptOwnerHttp" });
  canonicalOwner = resolveOwnerEntityIdOrDefault(fixture.runtime);
  registerHttpPluginRoutes(fixture.runtime, workflowRoutePlugin);
  unregisterResolver = registerTokenRoleResolver({
    id: "prompt-owner-http-test",
    resolve: (req) => {
      const token = req.headers["x-test-owner"];
      if (token !== "canonical" && token !== "foreign" && token !== "user")
        return null;
      return {
        providerId: "prompt-owner-http-test",
        worldRole: token === "user" ? "USER" : "OWNER",
        principal: token === "canonical" ? canonicalOwner : foreignOwner,
        isAdmin: token !== "user",
        isRouteInScope: () => true,
        claims: {},
      };
    },
  });
  server = await startApiServer({
    port: 0,
    runtime: fixture.runtime,
    skipDeferredStartupWork: true,
  });
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  unregisterResolver?.();
  if (fixture) await fixture.cleanup();
  vi.unstubAllEnvs();
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
}, 120_000);

function request(
  owner: "canonical" | "foreign" | "user",
  route: string,
  method = "GET",
  body?: object,
) {
  return fetch(`http://127.0.0.1:${server.port}${route}`, {
    method,
    headers: {
      "x-test-owner": owner,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

it("rejects a distinct registered OWNER before Node trigger/feed handlers can use local records", async () => {
  const title = `owner-probe-${randomUUID()}`;
  const createBody = {
    kind: "prompt",
    displayName: title,
    instructions: "Do not execute this disabled QA prompt",
    triggerType: "cron",
    cronExpression: "0 12 28 9 *",
    enabled: false,
    createdBy: "foreign-spoof",
    ownerEntityId: foreignOwner,
  };
  const created = await request(
    "canonical",
    "/api/triggers",
    "POST",
    createBody,
  );
  expect(created.status).toBe(201);
  const { trigger } = (await created.json()) as {
    trigger: { id: string; taskId: string };
  };
  const saved = await fixture.runtime.getTask(trigger.taskId as never);
  expect(saved?.entityId).toBe(canonicalOwner);
  expect((saved?.metadata?.ownership as { ownerId: string })?.ownerId).toBe(
    canonicalOwner,
  );

  for (const [method, route, body] of [
    ["GET", "/api/triggers"],
    ["GET", `/api/triggers/${trigger.id}`],
    ["GET", `/api/triggers/${trigger.id}/runs`],
    ["PUT", `/api/triggers/${trigger.id}`, { enabled: false }],
    ["DELETE", `/api/triggers/${trigger.id}`],
    ["POST", `/api/triggers/${trigger.id}/execute`],
    ["GET", "/api/automations"],
    ["POST", "/api/triggers", createBody],
  ] as const) {
    for (const principal of ["foreign", "user"] as const) {
      expect((await request(principal, route, method, body)).status).toBe(403);
    }
  }
  expect(
    (await request("canonical", `/api/triggers/${trigger.id}`)).status,
  ).toBe(200);
  const feed = await request("canonical", "/api/automations");
  expect(feed.status).toBe(200);
  expect(JSON.stringify(await feed.json())).toContain(trigger.id);
  expect(
    (await fixture.runtime.getTask(trigger.taskId as never))?.metadata?.trigger,
  ).toMatchObject({
    enabled: false,
    runCount: 0,
  });
});

it("keeps a persisted legacy heartbeat without entity ownership read-only", async () => {
  const taskId = await fixture.runtime.createTask({
    name: "HEARTBEAT",
    tags: ["queue", "repeat", "heartbeat"],
    metadata: { updateInterval: 60_000 },
  });
  const saved = await fixture.runtime.getTask(taskId);
  expect(saved?.entityId == null).toBe(true);
  const feed = await request("canonical", "/api/automations");
  expect(feed.status).toBe(200);
  const body = (await feed.json()) as {
    automations: Array<{
      triggerId?: string;
      system?: boolean;
      status: string;
    }>;
  };
  expect(
    body.automations.find((row) => row.triggerId === taskId),
  ).toMatchObject({ system: true, status: "system" });
  for (const [method, suffix, payload] of [
    ["PUT", "", { enabled: false }],
    ["DELETE", "", undefined],
    ["POST", "/execute", undefined],
  ] as const) {
    const response = await request(
      "canonical",
      `/api/triggers/${taskId}${suffix}`,
      method,
      payload,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "System trigger is read-only",
    });
  }
  expect(await fixture.runtime.getTask(taskId)).toMatchObject({
    id: taskId,
    tags: ["queue", "repeat", "heartbeat"],
  });
});

it("rejects stale presented credentials instead of promoting loopback access", async () => {
  for (const [name, value] of [
    ["Authorization", "Bearer stale-owner-token"],
    ["Cookie", "eliza_session=stale-session"],
  ] as const) {
    for (const route of ["/api/triggers", "/api/automations"]) {
      const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
        headers: { [name]: value },
      });
      expect(response.status).toBe(403);
    }
  }
});

it("renders persisted owner work and admitted automations without promoting maintenance queues into tasks", async () => {
  const prefix = `provider-${randomUUID()}`;
  const taskIds = [];
  for (const task of [
    { name: `${prefix}-active`, tags: ["workbench-task"] },
    {
      name: `${prefix}-completed`,
      tags: ["workbench-task"],
      metadata: { isCompleted: true },
    },
    { name: `${prefix}-custom`, tags: ["workbench-task", "custom-worker"] },
    { name: `${prefix}-spaced-tag`, tags: [" workbench-task "] },
    { name: `${prefix}-untagged-custom`, tags: ["queue", "repeat"] },
    { name: `${prefix}-todo`, tags: ["workbench-todo", "todo"] },
    ...["POST_TURN_MEMORY", "EMBEDDING_DRAIN", "PII_SCRUB_DRAIN"].map(
      (name) => ({ name, tags: ["queue", "repeat"] }),
    ),
  ]) {
    taskIds.push(
      await fixture.runtime.createTask({
        ...task,
        entityId: canonicalOwner as never,
      }),
    );
  }
  const triggerIds = [];
  for (const enabled of [true, false]) {
    const response = await request("canonical", "/api/triggers", "POST", {
      kind: "prompt",
      displayName: `${prefix}-${enabled ? "enabled" : "paused"}`,
      instructions: `${prefix}-${enabled}: do not run this future QA automation`,
      triggerType: "cron",
      cronExpression: "0 12 28 9 *",
      enabled,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { trigger: { taskId: string } };
    triggerIds.push(body.trigger.taskId);
  }
  const trigger = await fixture.runtime.getTask(triggerIds[0] as never);
  if (!trigger) throw new Error("Missing persisted HTTP trigger");
  const triggerConfig = readTriggerConfig(trigger);
  if (!triggerConfig)
    throw new Error("Missing persisted trigger configuration");
  taskIds.push(
    await fixture.runtime.createTask({
      name: `${prefix}-metadata-only-trigger`,
      tags: ["trigger"],
      metadata: {
        ...trigger.metadata,
        trigger: {
          ...triggerConfig,
          displayName: `${prefix}-metadata-only-trigger`,
        },
      },
    }),
  );
  const allIds = [...taskIds, ...triggerIds];
  const before = await Promise.all(
    allIds.map((id) => fixture.runtime.getTask(id as never)),
  );
  const provider = createOngoingTasksProvider();
  const get = () => provider.get(fixture.runtime, {} as Memory, {} as State);
  const result = await get();
  expect(result.text).toContain(`${prefix}-active`);
  expect(result.text).toContain(`[completed] ${prefix}-completed`);
  expect(result.text).toContain(`${prefix}-custom`);
  expect(result.text).toContain(`${prefix}-spaced-tag`);
  const feed = await request("canonical", "/api/automations");
  expect(feed.status).toBe(200);
  expect(JSON.stringify(await feed.json())).toContain(`${prefix}-spaced-tag`);
  expect(result.text).toContain(`${prefix}-enabled`);
  for (const excluded of [
    "POST_TURN_MEMORY",
    "EMBEDDING_DRAIN",
    "PII_SCRUB_DRAIN",
    `${prefix}-untagged-custom`,
    `${prefix}-todo`,
    `${prefix}-paused`,
    `${prefix}-metadata-only-trigger`,
  ])
    expect(result.text).not.toContain(excluded);
  const previous = process.env.ELIZA_TRIGGERS_ENABLED;
  try {
    process.env.ELIZA_TRIGGERS_ENABLED = "false";
    const disabled = await get();
    expect(disabled.text).toContain(`${prefix}-active`);
    expect(disabled.text).not.toContain(`${prefix}-enabled`);
  } finally {
    if (previous === undefined) delete process.env.ELIZA_TRIGGERS_ENABLED;
    else process.env.ELIZA_TRIGGERS_ENABLED = previous;
  }
  expect(
    await Promise.all(allIds.map((id) => fixture.runtime.getTask(id as never))),
  ).toEqual(before);
});

it("keeps workflow todo responses and host overview projections identical", async () => {
  const description = "Complete checklist context 🙂\n".repeat(100);
  const created = await request("canonical", "/api/workbench/todos", "POST", {
    name: `checklist-${randomUUID()}`,
    description,
    priority: "3",
    isUrgent: true,
    tags: [" detail "],
  });
  expect(created.status).toBe(201);
  const { todo } = await created.json();
  expect(todo).toMatchObject({
    description,
    priority: 3,
    isUrgent: true,
    isCompleted: false,
  });
  expect(todo.tags).toContain("detail");
  const overview = await request("canonical", "/api/workbench/overview");
  expect(overview.status).toBe(200);
  const { todos } = await overview.json();
  expect(todos.find((entry: { id: string }) => entry.id === todo.id)).toEqual(
    todo,
  );
  const completed = await request(
    "canonical",
    `/api/workbench/todos/${todo.id}/complete`,
    "POST",
    { isCompleted: true },
  );
  expect(completed.status).toBe(200);
  expect(await completed.json()).toEqual({ ok: true });
  const detail = await request("canonical", `/api/workbench/todos/${todo.id}`);
  expect(detail.status).toBe(200);
  const updated = (await detail.json()).todo;
  expect(updated).toMatchObject({ description, isCompleted: true });
  const after = await request("canonical", "/api/workbench/overview");
  expect(
    (await after.json()).todos.find(
      (entry: { id: string }) => entry.id === todo.id,
    ),
  ).toEqual(updated);
});
