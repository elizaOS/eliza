import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";

import { buildHonoAppForRuntime } from "../../../packages/agent/src/api/hono-adapter.ts";
import { simpleViewsPlugin } from "./plugin.js";
import { clearSimpleViewsStorageForTests } from "./storage.js";

function makeRuntime(): IAgentRuntime {
  return {
    routes: simpleViewsPlugin.routes,
  } as unknown as IAgentRuntime;
}

function makeRequest(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init);
}

describe("simple views plugin routes (real Hono dispatch)", () => {
  beforeEach(() => {
    clearSimpleViewsStorageForTests();
  });

  it("serves state, enforces write auth, and dispatches interactions", async () => {
    const runtime = makeRuntime();
    const unauthorized = buildHonoAppForRuntime(runtime, {
      isAuthorized: () => false,
    });

    const stateResponse = await unauthorized.fetch(
      makeRequest("/api/simple-views/state"),
    );
    expect(stateResponse.status).toBe(200);
    await expect(stateResponse.json()).resolves.toMatchObject({
      notes: expect.any(Array),
      events: expect.any(Array),
      selectedDate: expect.any(String),
    });

    const blockedWrite = await unauthorized.fetch(
      makeRequest("/api/simple-views/interact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: "create-note" }),
      }),
    );
    expect(blockedWrite.status).toBe(401);

    const authorized = buildHonoAppForRuntime(runtime, {
      isAuthorized: () => true,
    });
    const created = await authorized.fetch(
      makeRequest("/api/simple-views/interact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capability: "create-note",
          params: {
            title: "Route e2e note",
            body: "Created through the real Hono route dispatcher.",
            color: "green",
          },
        }),
      }),
    );
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      success: true,
      state: {
        notes: [expect.objectContaining({ title: "Route e2e note" })],
      },
    });
  });
});
