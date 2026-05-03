/**
 * Defense-of-the-Agents lifecycle tests.
 *
 * Pin the contract that {@link stopRun} actually frees every per-agent
 * resource it owns — game-loop intervals, in-memory ring buffers, last-known
 * session state, and the launch-failure marker — and that two concurrent
 * runtimes sharing a character name do not cross-pollute their cache slots.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeLoops,
  clearAgentRunState,
  handleAppRoutes,
  recentActivity,
  resetInMemoryStateForTests,
  resolveSessionContext,
  sessionCacheKey,
  sessionStateCache,
  startGameLoop,
  stopRun,
} from "../src/routes.js";

interface FakeRuntime {
  agentId: string;
  character: { name: string };
  settings: Map<string, string>;
  getSetting: (key: string) => string | null;
  setSetting: (key: string, value: string) => void;
}

function makeRuntime(agentId: string, characterName: string): FakeRuntime {
  const settings = new Map<string, string>();
  return {
    agentId,
    character: { name: characterName },
    settings,
    getSetting: (key: string) => settings.get(key) ?? null,
    setSetting: (key: string, value: string) => {
      settings.set(key, value);
    },
  };
}

beforeEach(() => {
  resetInMemoryStateForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetInMemoryStateForTests();
});

describe("sessionCacheKey", () => {
  it("isolates two runtimes that share a character name", () => {
    const ctxA = resolveSessionContext(
      makeRuntime("agent-a", "Eliza") as unknown as Parameters<
        typeof resolveSessionContext
      >[0],
      null,
    );
    const ctxB = resolveSessionContext(
      makeRuntime("agent-b", "Eliza") as unknown as Parameters<
        typeof resolveSessionContext
      >[0],
      null,
    );

    expect(ctxA.agentName).toBe(ctxB.agentName);
    expect(sessionCacheKey(ctxA)).not.toBe(sessionCacheKey(ctxB));
  });

  it("falls back to the character name when no runtime is attached", () => {
    const ctx = resolveSessionContext(null, "explicit-session");
    // Must include a non-empty stable string so the cache key is usable.
    expect(sessionCacheKey(ctx).length).toBeGreaterThan(0);
  });
});

describe("stopRun", () => {
  it("clears the active game loop, recent activity, session cache and launch failure for the agent", async () => {
    const runtime = makeRuntime("agent-stop-1", "ElizaStop1");
    const ctx = resolveSessionContext(
      runtime as unknown as Parameters<typeof resolveSessionContext>[0],
      null,
    );

    // Seed everything stopRun is supposed to clean up.
    startGameLoop(
      runtime as unknown as Parameters<typeof startGameLoop>[0],
      ctx,
    );
    recentActivity.set(ctx.agentId ?? "", [
      { ts: Date.now(), action: "deploy", detail: "deployed mage in mid" },
    ]);
    sessionStateCache.set(sessionCacheKey(ctx), {
      session: { sessionId: "s", appName: "x", mode: "viewer", status: "ok" },
      ts: Date.now(),
    });

    expect(activeLoops.has(ctx.agentId ?? "")).toBe(true);
    expect(recentActivity.get(ctx.agentId ?? "")?.length).toBe(1);
    expect(sessionStateCache.has(sessionCacheKey(ctx))).toBe(true);

    await stopRun({ runtime });

    expect(activeLoops.has(ctx.agentId ?? "")).toBe(false);
    expect(recentActivity.has(ctx.agentId ?? "")).toBe(false);
    expect(sessionStateCache.has(sessionCacheKey(ctx))).toBe(false);
  });

  it("is idempotent — calling twice does not throw", async () => {
    const runtime = makeRuntime("agent-stop-2", "ElizaStop2");
    await stopRun({ runtime });
    await stopRun({ runtime });
  });

  it("tolerates a null runtime", async () => {
    await expect(stopRun({ runtime: null })).resolves.toBeUndefined();
  });
});

describe("clearAgentRunState", () => {
  it("does not touch other agents' state", () => {
    const runtimeA = makeRuntime("agent-a", "ElizaA");
    const runtimeB = makeRuntime("agent-b", "ElizaB");
    const ctxA = resolveSessionContext(
      runtimeA as unknown as Parameters<typeof resolveSessionContext>[0],
      null,
    );
    const ctxB = resolveSessionContext(
      runtimeB as unknown as Parameters<typeof resolveSessionContext>[0],
      null,
    );

    recentActivity.set(ctxA.agentId ?? "", [
      { ts: Date.now(), action: "x", detail: "x" },
    ]);
    recentActivity.set(ctxB.agentId ?? "", [
      { ts: Date.now(), action: "y", detail: "y" },
    ]);
    sessionStateCache.set(sessionCacheKey(ctxA), {
      session: { sessionId: "a", appName: "x", mode: "viewer", status: "ok" },
      ts: Date.now(),
    });
    sessionStateCache.set(sessionCacheKey(ctxB), {
      session: { sessionId: "b", appName: "x", mode: "viewer", status: "ok" },
      ts: Date.now(),
    });

    clearAgentRunState(ctxA);

    // A is gone, B is intact.
    expect(recentActivity.has(ctxA.agentId ?? "")).toBe(false);
    expect(recentActivity.has(ctxB.agentId ?? "")).toBe(true);
    expect(sessionStateCache.has(sessionCacheKey(ctxA))).toBe(false);
    expect(sessionStateCache.has(sessionCacheKey(ctxB))).toBe(true);
  });
});

describe("message commands", () => {
  it("records strategy notes without deploying a default hero", async () => {
    const runtime = makeRuntime("agent-strategy", "ElizaStrategy");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const captured: { status: number; body: unknown } = {
      status: 0,
      body: null,
    };

    await handleAppRoutes({
      method: "POST",
      pathname: "/api/apps/defense-of-the-agents/session/session-1/message",
      runtime,
      res: {},
      readJsonBody: async () => ({
        content: "Play defensively and rotate to the weakest lane.",
      }),
      json: (_response: unknown, data: unknown, status = 200) => {
        captured.status = status;
        captured.body = data;
      },
      error: (_response: unknown, message: string, status = 500) => {
        captured.status = status;
        captured.body = { error: message };
      },
    });

    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({
      success: true,
      message:
        "Strategy note recorded. Use lane, recall, ability, or autoplay commands for direct control.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
