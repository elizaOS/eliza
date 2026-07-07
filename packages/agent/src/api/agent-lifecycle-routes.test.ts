/**
 * Covers handleAgentLifecycleRoutes: POST /api/agent/start (flag-flip when a
 * runtime is already live; a real on-demand boot through the injected
 * `onRestart` when it is null — 503 when no boot path exists, 500 + reported
 * "error" when the boot fails), and POST /api/agent/pause (running → paused).
 * Deterministic: mutates a plain in-memory state object with mocked json/error
 * responders and a fake runtime; no live model.
 */
import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentLifecycleRouteState,
  handleAgentLifecycleRoutes,
} from "./agent-lifecycle-routes";

function makeState(
  overrides: Partial<AgentLifecycleRouteState> = {},
): AgentLifecycleRouteState {
  return {
    runtime: null,
    agentState: "stopped",
    agentName: "Eliza",
    model: undefined,
    startedAt: undefined,
    ...overrides,
  };
}

/** Minimal AgentRuntime stand-in — only the fields the route reads. */
function fakeRuntime(name = "Eliza"): AgentRuntime {
  return { character: { name } } as unknown as AgentRuntime;
}

function makeCtx(
  method: string,
  pathname: string,
  state: AgentLifecycleRouteState = makeState(),
  extra: {
    onRestart?: () => Promise<AgentRuntime | null>;
    onRuntimeSwapped?: () => void;
  } = {},
) {
  const json = vi.fn();
  const error = vi.fn();
  return {
    ctx: {
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method,
      pathname,
      state,
      json,
      error,
      readJsonBody: vi.fn(),
      onRestart: extra.onRestart,
      onRuntimeSwapped: extra.onRuntimeSwapped,
    },
    state,
    json,
    error,
  };
}

describe("handleAgentLifecycleRoutes — POST /api/agent/start", () => {
  it("flag-flips a live-but-stopped runtime to running", async () => {
    const state = makeState({
      runtime: fakeRuntime(),
      agentState: "stopped",
    });
    const { ctx, json } = makeCtx("POST", "/api/agent/start", state);

    await expect(handleAgentLifecycleRoutes(ctx)).resolves.toBe(true);

    expect(state.agentState).toBe("running");
    expect(state.startedAt).toEqual(expect.any(Number));
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        ok: true,
        status: expect.objectContaining({ state: "running", uptime: 0 }),
      }),
    );
  });

  it("boots on demand through onRestart when the runtime is null", async () => {
    const swapped = vi.fn();
    const booted = fakeRuntime("Booted");
    const onRestart = vi.fn(async () => booted);
    const { ctx, state, json, error } = makeCtx(
      "POST",
      "/api/agent/start",
      makeState(),
      { onRestart, onRuntimeSwapped: swapped },
    );

    await expect(handleAgentLifecycleRoutes(ctx)).resolves.toBe(true);

    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(state.runtime).toBe(booted);
    expect(state.agentState).toBe("running");
    expect(state.agentName).toBe("Booted");
    expect(swapped).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        ok: true,
        status: expect.objectContaining({ state: "running" }),
      }),
    );
  });

  it("503s with no runtime and no boot path (fake-ready refused)", async () => {
    const { ctx, state, json, error } = makeCtx("POST", "/api/agent/start");

    await expect(handleAgentLifecycleRoutes(ctx)).resolves.toBe(true);

    // Never reports running with nothing behind it.
    expect(state.agentState).not.toBe("running");
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      expect.stringContaining("cannot boot"),
      503,
    );
  });

  it("500s + reports error when the on-demand boot throws", async () => {
    const onRestart = vi.fn(async () => {
      throw new Error("pglite open failed");
    });
    const { ctx, state, error } = makeCtx(
      "POST",
      "/api/agent/start",
      makeState(),
      { onRestart },
    );

    await expect(handleAgentLifecycleRoutes(ctx)).resolves.toBe(true);

    expect(state.agentState).toBe("error");
    expect(state.startedAt).toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      expect.stringContaining("pglite open failed"),
      500,
    );
  });

  it("500s + reports error when the boot returns no runtime", async () => {
    const onRestart = vi.fn(async () => null);
    const { ctx, state, error } = makeCtx(
      "POST",
      "/api/agent/start",
      makeState(),
      { onRestart },
    );

    await expect(handleAgentLifecycleRoutes(ctx)).resolves.toBe(true);

    expect(state.agentState).toBe("error");
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      expect.stringContaining("did not initialize"),
      500,
    );
  });

  it("is idempotent while a boot is already in progress (starting)", async () => {
    const onRestart = vi.fn(async () => fakeRuntime());
    const state = makeState({ agentState: "starting" });
    const { ctx, json } = makeCtx("POST", "/api/agent/start", state, {
      onRestart,
    });

    await expect(handleAgentLifecycleRoutes(ctx)).resolves.toBe(true);

    // Does not kick a second boot — reports the in-progress state.
    expect(onRestart).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        status: expect.objectContaining({ state: "starting" }),
      }),
    );
  });
});

describe("handleAgentLifecycleRoutes — POST /api/agent/pause", () => {
  it("moves running → paused", async () => {
    const state = makeState({
      runtime: fakeRuntime(),
      agentState: "running",
      startedAt: Date.now() - 1_000,
    });
    const { ctx, json } = makeCtx("POST", "/api/agent/pause", state);

    await expect(handleAgentLifecycleRoutes(ctx)).resolves.toBe(true);

    expect(state.agentState).toBe("paused");
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        ok: true,
        status: expect.objectContaining({
          state: "paused",
          agentName: "Eliza",
        }),
      }),
    );
  });
});
