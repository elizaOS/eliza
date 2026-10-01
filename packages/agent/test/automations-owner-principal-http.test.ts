/** Real Node HTTP boundary for owner-only prompt triggers and the legacy feed. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveOwnerEntityIdOrDefault } from "@elizaos/core";
import { registerHttpPluginRoutes } from "@elizaos/core/api/http-plugin-runtime";
import { createTestRuntime } from "@elizaos/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { workflowRoutePlugin } from "../../../plugins/plugin-workflow/src/plugin-routes.ts";
import { registerTokenRoleResolver } from "../src/api/boundary-role-resolver.ts";
import { startApiServer } from "../src/api/server.ts";

vi.mock("@elizaos/plugin-workflow", async () => ({
  handleTriggerRoutes: (
    await import("../../../plugins/plugin-workflow/src/trigger-routes.ts")
  ).handleTriggerRoutes,
}));

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
      if (token !== "canonical" && token !== "foreign") return null;
      return {
        providerId: "prompt-owner-http-test",
        worldRole: "OWNER",
        principal: token === "canonical" ? canonicalOwner : foreignOwner,
        isAdmin: true,
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
  owner: "canonical" | "foreign",
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
    expect((await request("foreign", route, method, body)).status).toBe(403);
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
