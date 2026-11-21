/**
 * The memory provider backs cloud E2E, so `/api/restore` must only answer
 * success when it actually applied the state: the real caller (`pushState` in
 * `eliza-sandbox/backup/service.ts`) inspects `res.ok` alone and a 200 means
 * "state hydrated". A body this double cannot parse used to be folded into
 * "no body" and answered `{ success: true }` with the agent state untouched.
 */
import { afterAll, describe, expect, it } from "bun:test";

import { MemorySandboxProvider } from "./memory-sandbox-provider";
import type { SandboxCreateConfig } from "./sandbox-provider-types";

const provider = new MemorySandboxProvider();
const sandboxIds: string[] = [];

const CREATE_CONFIG: SandboxCreateConfig = {
  agentId: "agent-restore-body-test",
  agentName: "Restore Body Test Agent",
  organizationId: "org-restore-body-test",
  executionTier: "dedicated-lazy",
  environmentVars: {},
};

async function newBridgeUrl(): Promise<string> {
  const handle = await provider.create(CREATE_CONFIG);
  sandboxIds.push(handle.sandboxId);
  return handle.bridgeUrl;
}

function postJson(bridgeUrl: string, pathname: string, body?: string): Promise<Response> {
  return fetch(`${bridgeUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function snapshot(bridgeUrl: string): Promise<Record<string, unknown>> {
  const response = await postJson(bridgeUrl, "/api/snapshot");
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

afterAll(async () => {
  for (const sandboxId of sandboxIds) {
    await provider.stopForDeletion(sandboxId);
  }
});

describe("MemorySandboxProvider /api/restore", () => {
  it("rejects a restore body it cannot parse instead of reporting success", async () => {
    const bridgeUrl = await newBridgeUrl();

    const response = await postJson(bridgeUrl, "/api/restore", "{oops");
    const body = (await response.json()) as { success?: unknown; error?: unknown };

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
  });

  it("rejects a missing restore body instead of reporting success", async () => {
    const bridgeUrl = await newBridgeUrl();

    const response = await postJson(bridgeUrl, "/api/restore");
    const body = (await response.json()) as { success?: unknown };

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
  });

  it("leaves the applied state untouched when a later restore body is rejected", async () => {
    const bridgeUrl = await newBridgeUrl();
    const restored = {
      memories: [{ role: "user", text: "keep me", timestamp: 1 }],
      config: { model: "eliza-1" },
      workspaceFiles: { "notes.md": "hello" },
    };

    const applied = await postJson(bridgeUrl, "/api/restore", JSON.stringify(restored));
    expect(applied.status).toBe(200);
    expect(await snapshot(bridgeUrl)).toEqual(restored);

    const rejected = await postJson(bridgeUrl, "/api/restore", '{"memories": [');
    expect(rejected.status).toBe(400);

    // A rejected restore must not be read as "restored empty".
    expect(await snapshot(bridgeUrl)).toEqual(restored);
  });

  it("still applies a well-formed restore", async () => {
    const bridgeUrl = await newBridgeUrl();
    const restored = {
      memories: [{ role: "assistant", text: "wake up", timestamp: 2 }],
      config: {},
      workspaceFiles: {},
    };

    const response = await postJson(bridgeUrl, "/api/restore", JSON.stringify(restored));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(await snapshot(bridgeUrl)).toEqual(restored);
  });
});
