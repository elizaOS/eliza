/** Custom-action CRUD over real HTTP keeps the live runtime action registry in step. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Action, Memory, UUID } from "@elizaos/core";
import { captureHostExecutionBaseline } from "@elizaos/host";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";
import {
  __setPinnedFetchImplForTests,
  setCustomActionsRuntime,
} from "../src/runtime/custom-actions.ts";

let directory: string;
let harness: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;
const terminalToken = randomUUID();

beforeAll(async () => {
  captureHostExecutionBaseline();
  directory = await mkdtemp(path.join(tmpdir(), "eliza-custom-action-live-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: "",
    ELIZA_REQUIRE_LOCAL_AUTH: "0",
    ELIZA_TERMINAL_RUN_TOKEN: terminalToken,
    ELIZA_RUNTIME_MODE: "local-yolo",
  }))
    vi.stubEnv(key, value);
  vi.stubEnv("ELIZA_CLOUD_PROVISIONED", undefined);
  harness = await createTestRuntime({ characterName: "CustomActionLive" });
  setCustomActionsRuntime(harness.runtime);
  server = await startApiServer({
    port: 0,
    runtime: harness.runtime,
    skipDeferredStartupWork: true,
  });
  vi.stubEnv("ELIZA_PORT", String(server.port));
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (harness) await harness.cleanup();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 120_000);

async function call(
  method: string,
  route: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Eliza-Terminal-Token": terminalToken,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

function liveAction(name: string): Action | undefined {
  return harness.runtime.actions.find((action) => action.name === name);
}

async function create(name: string, code: string): Promise<string> {
  const created = await call("POST", "/api/custom-actions", {
    name,
    description: `Returns a value for ${name}`,
    parameters: [],
    handler: { type: "code", code },
    enabled: true,
  });
  expect(created.status, JSON.stringify(created.json)).toBe(200);
  expect(liveAction(name)).toBeDefined();
  return (created.json.action as { id: string }).id;
}

async function invoke(action: Action | undefined): Promise<unknown> {
  if (!action) throw new Error("live action missing");
  const message = {
    id: randomUUID() as UUID,
    entityId: randomUUID() as UUID,
    roomId: randomUUID() as UUID,
    agentId: harness.runtime.agentId,
    content: { text: "run it" },
  } as Memory;
  const result = await action.handler(harness.runtime, message, undefined, {
    parameters: {},
  });
  return (result as { text?: string } | undefined)?.text;
}

it("removes the live action when the custom action is deleted", async () => {
  const id = await create("LIVE_DELETE_CHECK", "return 'alpha';");
  const deleted = await call("DELETE", `/api/custom-actions/${id}`);
  expect(deleted.status).toBe(200);
  expect(liveAction("LIVE_DELETE_CHECK")).toBeUndefined();
}, 60_000);

it("removes the live action when PUT disables it and restores it when re-enabled", async () => {
  const id = await create("LIVE_TOGGLE_CHECK", "return 'alpha';");
  const disabled = await call("PUT", `/api/custom-actions/${id}`, {
    enabled: false,
  });
  expect(disabled.status).toBe(200);
  expect(liveAction("LIVE_TOGGLE_CHECK")).toBeUndefined();
  const enabled = await call("PUT", `/api/custom-actions/${id}`, {
    enabled: true,
  });
  expect(enabled.status).toBe(200);
  expect(await invoke(liveAction("LIVE_TOGGLE_CHECK"))).toBe("alpha");
}, 60_000);

it("replaces the live action's description and handler on edit", async () => {
  const id = await create("LIVE_EDIT_CHECK", "return 'before';");
  expect(await invoke(liveAction("LIVE_EDIT_CHECK"))).toBe("before");
  const edited = await call("PUT", `/api/custom-actions/${id}`, {
    description: "Edited description",
    handler: { type: "code", code: "return 'after';" },
  });
  expect(edited.status).toBe(200);
  const matches = harness.runtime.actions.filter(
    (action) => action.name === "LIVE_EDIT_CHECK",
  );
  expect(matches).toHaveLength(1);
  expect(matches[0]?.description).toBe("Edited description");
  expect(await invoke(matches[0])).toBe("after");
}, 60_000);

it("moves the live action to the new name on rename", async () => {
  const id = await create("LIVE_RENAME_OLD", "return 'alpha';");
  const renamed = await call("PUT", `/api/custom-actions/${id}`, {
    name: "live rename new",
  });
  expect(renamed.status).toBe(200);
  expect(liveAction("LIVE_RENAME_OLD")).toBeUndefined();
  expect(await invoke(liveAction("LIVE_RENAME_NEW"))).toBe("alpha");
}, 60_000);

it("fills {{param}} in HTTP header values on the Test route", async () => {
  const sent: Array<{
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  // Only the outbound transport is replaced; the URL safety check still runs.
  __setPinnedFetchImplForTests(async ({ url, init }) => {
    sent.push({
      url: String(url),
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body,
    });
    return new Response("ok", { status: 200 });
  });
  try {
    const created = await call("POST", "/api/custom-actions", {
      name: "LIVE_HEADER_PARAMS",
      description: "Posts to a notification hook",
      parameters: [
        { name: "channel", description: "Channel", required: true },
        { name: "token", description: "API token", required: true },
      ],
      handler: {
        type: "http",
        method: "POST",
        url: "https://93.184.215.14/notify/{{channel}}",
        headers: {
          Authorization: "Bearer {{token}}",
          "X-Channel": "{{channel}}",
        },
        bodyTemplate: '{"channel":"{{channel}}"}',
      },
      enabled: true,
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = (created.json.action as { id: string }).id;

    const tested = await call("POST", `/api/custom-actions/${id}/test`, {
      params: { channel: "ops", token: "abc123" },
    });
    expect(tested.status).toBe(200);
    expect(tested.json.ok).toBe(true);
    expect(sent[0]?.url).toBe("https://93.184.215.14/notify/ops");
    expect(sent[0]?.headers.Authorization).toBe("Bearer abc123");
    expect(sent[0]?.headers["X-Channel"]).toBe("ops");

    // Each call fills a fresh copy of the header templates.
    const second = await call("POST", `/api/custom-actions/${id}/test`, {
      params: { channel: "alerts$&", token: "xyz789" },
    });
    expect(second.status).toBe(200);
    expect(sent[1]?.headers.Authorization).toBe("Bearer xyz789");
    expect(sent[1]?.headers["X-Channel"]).toBe("alerts$&");
    // A "$" pattern in a value is inserted as written, not expanded.
    expect(sent[1]?.body).toBe('{"channel":"alerts$&"}');
  } finally {
    __setPinnedFetchImplForTests(null);
  }
}, 60_000);
