// Server half of the #12178 runtime-switch contract. POST /api/runtime/
// model-switch applies the switch through the existing local-inference routes
// (injected loopbackFetch) and broadcasts shell:model-switch; POST
// /api/runtime/agent-switch broadcasts shell:switch-agent and resolves against
// a frontend result callback. The frontend halves are covered in packages/ui.
//
// Focused route unit test: real body parsing (Readable), a fake loopback fetch
// standing in for the local-inference routes, no PGLite/runtime/LLM.

import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleRuntimeSwitchRoutes,
  type RuntimeSwitchRouteContext,
  resolveAgentSwitchResult,
} from "./runtime-switch-routes.ts";

type Body = Record<string, unknown>;

/** A fake local-inference loopback: records calls and replays scripted responses. */
function fakeLoopback(routes: Record<string, { status: number; body: Body }>): {
  fetch: typeof fetch;
  calls: Array<{ method: string; path: string; body: Body | null }>;
} {
  const calls: Array<{ method: string; path: string; body: Body | null }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Body) : null;
    calls.push({ method, path: u.pathname, body });
    const key = `${method} ${u.pathname}`;
    const route = routes[key] ?? { status: 404, body: { error: "not mocked" } };
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function makeCtx(
  method: string,
  pathname: string,
  body: Body | null,
  loopbackFetch?: typeof fetch,
): {
  ctx: RuntimeSwitchRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  broadcastWs: ReturnType<typeof vi.fn>;
} {
  const req = Readable.from(
    body === null ? [] : [Buffer.from(JSON.stringify(body))],
  ) as unknown as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const json = vi.fn();
  const error = vi.fn();
  const broadcastWs = vi.fn();
  const ctx: RuntimeSwitchRouteContext = {
    req,
    res,
    method,
    pathname,
    json,
    error,
    broadcastWs,
    ...(loopbackFetch ? { loopbackFetch } : {}),
  };
  return { ctx, json, error, broadcastWs };
}

/**
 * Await real macrotask ticks until `predicate` holds. The route parses the
 * request body from a stream before it broadcasts, so the broadcast lands a
 * few ticks after the handler is invoked — not on the first microtask.
 */
async function flushUntil(predicate: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("POST /api/runtime/model-switch", () => {
  it("switches to cloud: flips both text slots and broadcasts shell:model-switch", async () => {
    const loop = fakeLoopback({
      "POST /api/local-inference/routing/preferred": {
        status: 200,
        body: { preferences: {} },
      },
      "POST /api/local-inference/routing/policy": {
        status: 200,
        body: { preferences: {} },
      },
    });
    const { ctx, json, broadcastWs } = makeCtx(
      "POST",
      "/api/runtime/model-switch",
      { target: "cloud" },
      loop.fetch,
    );

    expect(await handleRuntimeSwitchRoutes(ctx)).toBe(true);

    const preferredCalls = loop.calls.filter(
      (c) => c.path === "/api/local-inference/routing/preferred",
    );
    expect(preferredCalls).toHaveLength(2); // TEXT_SMALL + TEXT_LARGE
    expect(preferredCalls.every((c) => c.body?.provider === "elizacloud")).toBe(
      true,
    );

    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "shell:model-switch",
        target: "cloud",
        status: "ready",
      }),
    );
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ok: true, target: "cloud" }),
    );
  });

  it("switches to a locally-installed model: assigns, routes local, activates", async () => {
    const loop = fakeLoopback({
      "POST /api/local-inference/assignments": {
        status: 200,
        body: { assignments: { TEXT_LARGE: "eliza-1-2b" } },
      },
      "POST /api/local-inference/routing/preferred": {
        status: 200,
        body: { preferences: {} },
      },
      "POST /api/local-inference/routing/policy": {
        status: 200,
        body: { preferences: {} },
      },
      "GET /api/local-inference/installed": {
        status: 200,
        body: { models: [{ id: "eliza-1-2b" }] },
      },
      "POST /api/local-inference/active": {
        status: 200,
        body: { modelId: "eliza-1-2b", status: "ready" },
      },
    });
    const { ctx, json, broadcastWs } = makeCtx(
      "POST",
      "/api/runtime/model-switch",
      { target: "local", model: "eliza-1-2b" },
      loop.fetch,
    );

    expect(await handleRuntimeSwitchRoutes(ctx)).toBe(true);
    expect(
      loop.calls.some((c) => c.path === "/api/local-inference/active"),
    ).toBe(true);
    expect(
      loop.calls.some((c) => c.path === "/api/local-inference/downloads"),
    ).toBe(false);
    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "shell:model-switch",
        target: "local",
        model: "eliza-1-2b",
        status: "ready",
      }),
    );
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ok: true, status: "ready" }),
    );
  });

  it("switches to a not-yet-installed model: starts a download instead of activating", async () => {
    const loop = fakeLoopback({
      "POST /api/local-inference/assignments": {
        status: 200,
        body: { assignments: {} },
      },
      "POST /api/local-inference/routing/preferred": {
        status: 200,
        body: { preferences: {} },
      },
      "POST /api/local-inference/routing/policy": {
        status: 200,
        body: { preferences: {} },
      },
      "GET /api/local-inference/installed": {
        status: 200,
        body: { models: [] },
      },
      "POST /api/local-inference/downloads": {
        status: 202,
        body: { job: { modelId: "eliza-1-4b" } },
      },
    });
    const { ctx, broadcastWs } = makeCtx(
      "POST",
      "/api/runtime/model-switch",
      { target: "local", model: "eliza-1-4b" },
      loop.fetch,
    );

    expect(await handleRuntimeSwitchRoutes(ctx)).toBe(true);
    expect(
      loop.calls.some((c) => c.path === "/api/local-inference/downloads"),
    ).toBe(true);
    expect(
      loop.calls.some((c) => c.path === "/api/local-inference/active"),
    ).toBe(false);
    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "shell:model-switch",
        status: "downloading",
      }),
    );
  });

  it("rejects a non-sanctioned local model at the boundary (no loopback calls)", async () => {
    const loop = fakeLoopback({});
    const { ctx, error } = makeCtx(
      "POST",
      "/api/runtime/model-switch",
      { target: "local", model: "llama-3-8b" },
      loop.fetch,
    );

    expect(await handleRuntimeSwitchRoutes(ctx)).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("not a sanctioned local model"),
      400,
    );
    expect(loop.calls).toHaveLength(0);
  });

  it("rejects a non-default cloud model at the boundary", async () => {
    const loop = fakeLoopback({});
    const { ctx, error } = makeCtx(
      "POST",
      "/api/runtime/model-switch",
      { target: "cloud", model: "gpt-5" },
      loop.fetch,
    );
    expect(await handleRuntimeSwitchRoutes(ctx)).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("not a sanctioned cloud model"),
      400,
    );
  });

  it("rejects a missing/invalid target", async () => {
    const { ctx, error } = makeCtx("POST", "/api/runtime/model-switch", {
      target: "gpu",
    });
    expect(await handleRuntimeSwitchRoutes(ctx)).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("local"),
      400,
    );
  });

  it("returns 502 when a local-inference route fails", async () => {
    const loop = fakeLoopback({
      "POST /api/local-inference/routing/preferred": {
        status: 500,
        body: { error: "disk full" },
      },
    });
    const { ctx, error } = makeCtx(
      "POST",
      "/api/runtime/model-switch",
      { target: "cloud" },
      loop.fetch,
    );
    expect(await handleRuntimeSwitchRoutes(ctx)).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("Model switch failed"),
      502,
    );
  });
});

describe("POST /api/runtime/agent-switch", () => {
  afterEach(() => vi.useRealTimers());

  it("broadcasts shell:switch-agent and resolves when the shell reports success", async () => {
    const { ctx, json, broadcastWs } = makeCtx(
      "POST",
      "/api/runtime/agent-switch",
      {
        profile: "cloud",
      },
    );

    const done = handleRuntimeSwitchRoutes(ctx);
    await flushUntil(() => broadcastWs.mock.calls.length > 0);
    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({ type: "shell:switch-agent", profile: "cloud" }),
    );
    const requestId = (broadcastWs.mock.calls[0][0] as { requestId: string })
      .requestId;
    expect(typeof requestId).toBe("string");

    resolveAgentSwitchResult({
      requestId,
      ok: true,
      profileId: "p1",
      profileLabel: "My Cloud Agent",
    });

    expect(await done).toBe(true);
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ok: true,
        profileId: "p1",
        profileLabel: "My Cloud Agent",
      }),
    );
  });

  it("relays an untrusted-remote refusal from the shell", async () => {
    const { ctx, json, broadcastWs } = makeCtx(
      "POST",
      "/api/runtime/agent-switch",
      {
        profile: "my vps",
      },
    );
    const done = handleRuntimeSwitchRoutes(ctx);
    await flushUntil(() => broadcastWs.mock.calls.length > 0);
    const requestId = (broadcastWs.mock.calls[0][0] as { requestId: string })
      .requestId;
    resolveAgentSwitchResult({
      requestId,
      ok: false,
      reason: "untrusted-remote",
    });
    expect(await done).toBe(true);
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ok: false, reason: "untrusted-remote" }),
    );
  });

  it("degrades to no-shell when no shell answers before the timeout", async () => {
    vi.useFakeTimers();
    const { ctx, json } = makeCtx("POST", "/api/runtime/agent-switch", {
      profile: "cloud",
    });
    const done = handleRuntimeSwitchRoutes(ctx);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(await done).toBe(true);
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ok: false, reason: "no-shell" }),
    );
  });

  it("returns no-shell immediately when no broadcast transport is present", async () => {
    const { ctx, json } = makeCtx("POST", "/api/runtime/agent-switch", {
      profile: "cloud",
    });
    ctx.broadcastWs = undefined;
    expect(await handleRuntimeSwitchRoutes(ctx)).toBe(true);
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ok: false, reason: "no-shell" }),
    );
  });

  it("rejects a missing profile", async () => {
    const { ctx, error } = makeCtx("POST", "/api/runtime/agent-switch", {});
    expect(await handleRuntimeSwitchRoutes(ctx)).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      "profile is required",
      400,
    );
  });
});

describe("route matching", () => {
  it("returns false for unrelated paths", async () => {
    const { ctx } = makeCtx("POST", "/api/views/foo/navigate", {});
    expect(await handleRuntimeSwitchRoutes(ctx)).toBe(false);
  });
});
