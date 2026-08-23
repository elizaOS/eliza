/**
 * Covers handleAgentAdminRoutes: POST /api/agent/restart (501 with no handler,
 * 409 while a restart is already in progress, successful swap + quiesce,
 * null/throw restore the previous reported state) and POST /api/agent/reset
 * (stop runtime, delete only a `.elizadb` data dir, first-run wipe, cloud vault
 * keys, conversation map clear). Deterministic: mutates a plain in-memory state
 * object with mocked json/error responders and a fake runtime; no live model.
 */
import type http from "node:http";
import type { AgentRuntime, UUID } from "@elizaos/core";
import { getDefaultStylePreset } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  loadedConfig: {
    ui: {
      assistant: { name: "ConfigAgent" },
      language: undefined as string | undefined,
    },
    agents: {
      list: [] as Array<{ name?: string }>,
      defaults: { workspace: "/tmp/eliza-workspace" },
    },
    database: { pglite: { dataDir: undefined as string | undefined } },
  },
  loadElizaConfig: vi.fn(),
  saveElizaConfig: vi.fn(),
  resolveUserPath: vi.fn((value: string) => value),
  detectRuntimeModel: vi.fn((_runtime: AgentRuntime) => "detected-model"),
  clearPersistedFirstRunConfig: vi.fn(),
  quiesceRuntimeBeforeReplacement: vi.fn(async () => undefined),
  createRuntimeAccountStoragePolicy: vi.fn((stateRoot: string) => ({
    stateRoot,
    authRoot: `${stateRoot}/auth`,
    owner: "runtime",
  })),
  vaultRemove: vi.fn(async (_key: string) => undefined),
  sharedVault: vi.fn(),
  getAgentHostBridge: vi.fn(),
}));

vi.mock("@elizaos/auth/account-storage", () => ({
  createRuntimeAccountStoragePolicy: fakes.createRuntimeAccountStoragePolicy,
}));
vi.mock("../config/config.ts", () => ({
  loadElizaConfig: fakes.loadElizaConfig,
  saveElizaConfig: fakes.saveElizaConfig,
}));
vi.mock("../config/paths.ts", () => ({
  resolveUserPath: fakes.resolveUserPath,
}));
vi.mock("../runtime/host-bridge.ts", () => ({
  getAgentHostBridge: fakes.getAgentHostBridge,
}));
vi.mock("./agent-model.ts", () => ({
  detectRuntimeModel: fakes.detectRuntimeModel,
}));
vi.mock("./provider-switch-config.ts", () => ({
  clearPersistedFirstRunConfig: fakes.clearPersistedFirstRunConfig,
}));
vi.mock("./runtime-replacement-ownership.ts", () => ({
  quiesceRuntimeBeforeReplacement: fakes.quiesceRuntimeBeforeReplacement,
}));

import {
  type AgentAdminRouteState,
  handleAgentAdminRoutes,
} from "./agent-admin-routes";

const STATE_DIR = "/tmp/eliza-state";
const ORIGINAL_PGLITE_DATA_DIR = process.env.PGLITE_DATA_DIR;

function makeState(
  overrides: Partial<AgentAdminRouteState> = {},
): AgentAdminRouteState {
  return {
    runtime: null,
    config: {
      ui: { assistant: { name: "Eliza" } },
    } as AgentAdminRouteState["config"],
    agentState: "stopped",
    agentName: "Eliza",
    model: undefined,
    startedAt: undefined,
    chatRoomId: "room-1" as UUID,
    chatUserId: "user-1" as UUID,
    chatConnectionReady: {
      userId: "user-1" as UUID,
      roomId: "room-1" as UUID,
      worldId: "world-1" as UUID,
    },
    chatConnectionPromise: Promise.resolve(),
    pendingRestartReasons: ["stale-model"],
    conversations: new Map([["c1", { id: "c1" }]]),
    activeConversationId: "c1",
    conversationRestorePromise: Promise.resolve(),
    ...overrides,
  };
}

/** Minimal AgentRuntime stand-in — only the fields the route reads. */
function fakeRuntime(name?: string): AgentRuntime {
  const stop = vi.fn(async (_opts?: { fast?: boolean }) => undefined);
  return {
    character: { name },
    stop,
  } as unknown as AgentRuntime;
}

function makeCtx(
  method: string,
  pathname: string,
  state: AgentAdminRouteState = makeState(),
  extra: {
    onRestart?: () => Promise<AgentRuntime | null>;
    onRuntimeSwapped?: () => void;
    onRuntimeActivated?: (
      previousRuntime: AgentRuntime | null,
      activeRuntime: AgentRuntime,
    ) => void | Promise<void>;
    resolveStateDir?: () => string;
    stateDirExists?: (resolvedState: string) => boolean;
    removeStateDir?: (resolvedState: string) => void;
    logWarn?: (message: string) => void;
  } = {},
) {
  const json = vi.fn();
  const error = vi.fn();
  const resolveStateDir = extra.resolveStateDir ?? (() => STATE_DIR);
  const stateDirExists = extra.stateDirExists ?? vi.fn(() => false);
  const removeStateDir = extra.removeStateDir ?? vi.fn();
  const logWarn = extra.logWarn ?? vi.fn();
  return {
    ctx: {
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method,
      pathname,
      state,
      json,
      error,
      onRestart: extra.onRestart,
      onRuntimeSwapped: extra.onRuntimeSwapped,
      onRuntimeActivated: extra.onRuntimeActivated,
      resolveStateDir,
      stateDirExists,
      removeStateDir,
      logWarn,
    },
    state,
    json,
    error,
    stateDirExists,
    removeStateDir,
    logWarn,
  };
}

beforeEach(() => {
  fakes.loadedConfig = {
    ui: { assistant: { name: "ConfigAgent" }, language: undefined },
    agents: {
      list: [],
      defaults: { workspace: "/tmp/eliza-workspace" },
    },
    database: { pglite: { dataDir: undefined } },
  };
  fakes.loadElizaConfig
    .mockReset()
    .mockImplementation(() => fakes.loadedConfig);
  fakes.saveElizaConfig.mockReset();
  fakes.resolveUserPath
    .mockReset()
    .mockImplementation((value: string) => value);
  fakes.detectRuntimeModel.mockReset().mockReturnValue("detected-model");
  fakes.clearPersistedFirstRunConfig.mockReset();
  fakes.quiesceRuntimeBeforeReplacement
    .mockReset()
    .mockResolvedValue(undefined);
  fakes.createRuntimeAccountStoragePolicy
    .mockReset()
    .mockImplementation((stateRoot: string) => ({
      stateRoot,
      authRoot: `${stateRoot}/auth`,
      owner: "runtime",
    }));
  fakes.vaultRemove.mockReset().mockResolvedValue(undefined);
  fakes.sharedVault.mockReset().mockReturnValue({ remove: fakes.vaultRemove });
  fakes.getAgentHostBridge
    .mockReset()
    .mockReturnValue({ sharedVault: fakes.sharedVault });
});

afterEach(() => {
  if (ORIGINAL_PGLITE_DATA_DIR === undefined) {
    delete process.env.PGLITE_DATA_DIR;
  } else {
    process.env.PGLITE_DATA_DIR = ORIGINAL_PGLITE_DATA_DIR;
  }
});

describe("handleAgentAdminRoutes — unmatched paths", () => {
  it("returns false for a method/path this module does not own", async () => {
    const { ctx, json, error } = makeCtx("GET", "/api/agent/restart");

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(false);

    expect(json).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("returns false for POST /api/agent/start (lifecycle, not admin)", async () => {
    const { ctx, json, error } = makeCtx("POST", "/api/agent/start");

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(false);

    expect(json).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("handleAgentAdminRoutes — POST /api/agent/restart", () => {
  it("501s when no restart handler is registered", async () => {
    const state = makeState({ agentState: "running" });
    const { ctx, json, error } = makeCtx("POST", "/api/agent/restart", state);

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(state.agentState).toBe("running");
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Restart is not supported in this mode (no restart handler registered)",
      501,
    );
  });

  it("409s without calling onRestart when a restart is already in progress", async () => {
    const onRestart = vi.fn(async () => fakeRuntime("Booted"));
    const state = makeState({ agentState: "restarting" });
    const { ctx, json, error } = makeCtx("POST", "/api/agent/restart", state, {
      onRestart,
    });

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(onRestart).not.toHaveBeenCalled();
    expect(state.agentState).toBe("restarting");
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "A restart is already in progress",
      409,
    );
  });

  it("swaps in the new runtime, quiesces the old one, and reports running", async () => {
    const previous = fakeRuntime("Old");
    const booted = fakeRuntime("Booted");
    const onRestart = vi.fn(async () => booted);
    const swapped = vi.fn();
    const activated = vi.fn();
    const before = Date.now();
    const state = makeState({
      runtime: previous,
      agentState: "running",
      agentName: "Old",
      model: "old-model",
      startedAt: 1,
    });
    const { ctx, json, error } = makeCtx("POST", "/api/agent/restart", state, {
      onRestart,
      onRuntimeSwapped: swapped,
      onRuntimeActivated: activated,
    });

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(fakes.quiesceRuntimeBeforeReplacement).toHaveBeenCalledWith(
      previous,
      booted,
    );
    expect(state.runtime).toBe(booted);
    expect(state.chatConnectionReady).toBeNull();
    expect(state.chatConnectionPromise).toBeNull();
    expect(state.agentState).toBe("running");
    expect(state.agentName).toBe("Booted");
    expect(fakes.detectRuntimeModel).toHaveBeenCalledWith(booted);
    expect(state.model).not.toBe("old-model");
    expect(state.startedAt).toEqual(expect.any(Number));
    expect(state.startedAt as number).toBeGreaterThanOrEqual(before);
    expect(state.pendingRestartReasons).toEqual([]);
    expect(swapped).toHaveBeenCalledTimes(1);
    expect(activated).toHaveBeenCalledWith(previous, booted);
    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        ok: true,
        pendingRestart: false,
        status: expect.objectContaining({
          state: "running",
          agentName: "Booted",
        }),
      }),
    );
  });

  it("falls back to ui.assistant.name when the new runtime has no character name", async () => {
    const booted = fakeRuntime(undefined);
    const state = makeState({
      agentState: "running",
      config: {
        ui: { assistant: { name: "  Assistant From Config  " } },
      } as AgentAdminRouteState["config"],
    });
    const { ctx } = makeCtx("POST", "/api/agent/restart", state, {
      onRestart: async () => booted,
    });

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(state.agentName).toBe("Assistant From Config");
  });

  it("falls back to agents.list[0].name when the assistant name is absent", async () => {
    const booted = fakeRuntime(undefined);
    const state = makeState({
      agentState: "paused",
      config: {
        ui: { language: "en" },
        agents: { list: [{ name: "  Listed Agent  " }] },
      } as AgentAdminRouteState["config"],
    });
    const { ctx } = makeCtx("POST", "/api/agent/restart", state, {
      onRestart: async () => booted,
    });

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(state.agentName).toBe("Listed Agent");
  });

  it("does not use agents.list when a whitespace assistant name trims to empty", async () => {
    // `??` does not skip "" — a blank assistant name is configured-but-empty,
    // so the route falls through to the style-preset default, not the list.
    const booted = fakeRuntime(undefined);
    const state = makeState({
      agentState: "paused",
      config: {
        ui: { assistant: { name: "   " } },
        agents: { list: [{ name: "Listed Agent" }] },
      } as AgentAdminRouteState["config"],
    });
    const { ctx } = makeCtx("POST", "/api/agent/restart", state, {
      onRestart: async () => booted,
    });

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(state.agentName).toBe(getDefaultStylePreset().name);
    expect(state.agentName).not.toBe("Listed Agent");
  });

  it("falls back to the default style-preset name when no configured name exists", async () => {
    const booted = fakeRuntime(undefined);
    const state = makeState({
      agentState: "running",
      config: {
        ui: { language: "en" },
        agents: { list: [] },
      } as AgentAdminRouteState["config"],
    });
    const { ctx } = makeCtx("POST", "/api/agent/restart", state, {
      onRestart: async () => booted,
    });

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(state.agentName).toBe(getDefaultStylePreset("en").name);
  });

  it("restores the previous state when onRestart returns null", async () => {
    const previous = fakeRuntime("Old");
    const onRestart = vi.fn(async () => null);
    const swapped = vi.fn();
    const state = makeState({
      runtime: previous,
      agentState: "paused",
      agentName: "Old",
    });
    const { ctx, json, error } = makeCtx("POST", "/api/agent/restart", state, {
      onRestart,
      onRuntimeSwapped: swapped,
    });

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(state.runtime).toBe(previous);
    expect(state.agentState).toBe("paused");
    expect(swapped).not.toHaveBeenCalled();
    expect(fakes.quiesceRuntimeBeforeReplacement).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Restart handler returned null — runtime failed to re-initialize",
      500,
    );
  });

  it("restores the previous state when onRestart throws an Error", async () => {
    const previous = fakeRuntime("Old");
    const onRestart = vi.fn(async () => {
      throw new Error("pglite open failed");
    });
    const state = makeState({
      runtime: previous,
      agentState: "running",
    });
    const { ctx, error } = makeCtx("POST", "/api/agent/restart", state, {
      onRestart,
    });

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(state.runtime).toBe(previous);
    expect(state.agentState).toBe("running");
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Restart failed: pglite open failed",
      500,
    );
  });

  it("stringifies a non-Error throw from onRestart", async () => {
    const onRestart = vi.fn(async () => {
      throw "boom";
    });
    const state = makeState({ agentState: "stopped" });
    const { ctx, error } = makeCtx("POST", "/api/agent/restart", state, {
      onRestart,
    });

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(state.agentState).toBe("stopped");
    expect(error).toHaveBeenCalledWith(ctx.res, "Restart failed: boom", 500);
  });

  it("does not require optional swap/activation callbacks", async () => {
    const booted = fakeRuntime("Booted");
    const { ctx, json, error } = makeCtx(
      "POST",
      "/api/agent/restart",
      makeState({ agentState: "stopped", runtime: null }),
      { onRestart: async () => booted },
    );

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalled();
    expect(fakes.quiesceRuntimeBeforeReplacement).toHaveBeenCalledWith(
      null,
      booted,
    );
  });
});

describe("handleAgentAdminRoutes — POST /api/agent/reset", () => {
  it("stops a live runtime with { fast: true } and reports ok", async () => {
    const runtime = fakeRuntime("Live");
    const state = makeState({
      runtime,
      agentState: "running",
      model: "old-model",
      startedAt: 99,
    });
    const { ctx, json, error } = makeCtx("POST", "/api/agent/reset", state);

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(
      (runtime as unknown as { stop: ReturnType<typeof vi.fn> }).stop,
    ).toHaveBeenCalledWith({ fast: true });
    expect(state.runtime).toBeNull();
    expect(state.agentState).toBe("stopped");
    expect(state.model).toBeUndefined();
    expect(state.startedAt).toBeUndefined();
    expect(state.chatRoomId).toBeNull();
    expect(state.chatUserId).toBeNull();
    expect(state.chatConnectionReady).toBeNull();
    expect(state.chatConnectionPromise).toBeNull();
    expect(state.pendingRestartReasons).toEqual([]);
    expect(state.conversations?.size).toBe(0);
    expect(state.activeConversationId).toBeNull();
    expect(state.conversationRestorePromise).toBeNull();
    expect(state.config).toBe(fakes.loadedConfig);
    expect(state.agentName).toBe("ConfigAgent");
    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(ctx.res, { ok: true });
  });

  it("skips stop when there is no runtime and still resets reported state", async () => {
    const state = makeState({ runtime: null, agentState: "error" });
    const { ctx, json } = makeCtx("POST", "/api/agent/reset", state);

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(state.agentState).toBe("stopped");
    expect(json).toHaveBeenCalledWith(ctx.res, { ok: true });
  });

  it("does not throw when conversations is absent", async () => {
    const state = makeState({ conversations: undefined });
    const { ctx, json, error } = makeCtx("POST", "/api/agent/reset", state);

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(ctx.res, { ok: true });
  });

  it("deletes the env PGlite dir only when its basename is .elizadb and it exists", async () => {
    process.env.PGLITE_DATA_DIR = "/tmp/custom/.elizadb";
    const existing = new Set(["/tmp/custom/.elizadb"]);
    const { ctx, json, removeStateDir, logWarn } = makeCtx(
      "POST",
      "/api/agent/reset",
      makeState(),
      {
        stateDirExists: (p) => existing.has(p),
      },
    );

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(removeStateDir).toHaveBeenCalledWith("/tmp/custom/.elizadb");
    expect(logWarn).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(ctx.res, { ok: true });
  });

  it("refuses to delete an env PGlite dir whose basename is not .elizadb", async () => {
    process.env.PGLITE_DATA_DIR = "/tmp/not-the-db";
    const { ctx, removeStateDir, logWarn } = makeCtx(
      "POST",
      "/api/agent/reset",
      makeState(),
      { stateDirExists: () => true },
    );

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(removeStateDir).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Refusing to delete unexpected PGlite dir during reset: "/tmp/not-the-db"',
      ),
    );
  });

  it("treats a whitespace-only PGLITE_DATA_DIR as unset and uses the config dataDir", async () => {
    process.env.PGLITE_DATA_DIR = "   ";
    fakes.loadedConfig.database.pglite.dataDir = "/var/lib/eliza/.elizadb";
    const { ctx, removeStateDir } = makeCtx(
      "POST",
      "/api/agent/reset",
      makeState(),
      { stateDirExists: (p) => p === "/var/lib/eliza/.elizadb" },
    );

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(removeStateDir).toHaveBeenCalledWith("/var/lib/eliza/.elizadb");
  });

  it("refuses a configured dataDir whose basename is not .elizadb", async () => {
    fakes.loadedConfig.database.pglite.dataDir = "/var/lib/eliza/pgdata";
    const { ctx, removeStateDir, logWarn } = makeCtx(
      "POST",
      "/api/agent/reset",
      makeState(),
      { stateDirExists: () => true },
    );

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(removeStateDir).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("/var/lib/eliza/pgdata"),
    );
  });

  it("deletes workspace/.elizadb when no explicit dataDir is set and the path exists", async () => {
    const expected = "/tmp/eliza-workspace/.elizadb";
    const { ctx, removeStateDir } = makeCtx(
      "POST",
      "/api/agent/reset",
      makeState(),
      { stateDirExists: (p) => p === expected },
    );

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(removeStateDir).toHaveBeenCalledWith(expected);
  });

  it("defaults the workspace to <stateDir>/workspace when agents.defaults.workspace is absent", async () => {
    fakes.loadedConfig.agents.defaults.workspace =
      undefined as unknown as string;
    const expected = `${STATE_DIR}/workspace/.elizadb`;
    const { ctx, removeStateDir } = makeCtx(
      "POST",
      "/api/agent/reset",
      makeState(),
      { stateDirExists: (p) => p === expected },
    );

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(removeStateDir).toHaveBeenCalledWith(expected);
  });

  it("skips delete when the .elizadb path does not exist", async () => {
    const { ctx, removeStateDir, logWarn } = makeCtx(
      "POST",
      "/api/agent/reset",
      makeState(),
      { stateDirExists: () => false },
    );

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(removeStateDir).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("clears first-run config through the runtime account-storage policy and persists it", async () => {
    const { ctx } = makeCtx("POST", "/api/agent/reset", makeState());

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(fakes.createRuntimeAccountStoragePolicy).toHaveBeenCalledWith(
      STATE_DIR,
    );
    expect(fakes.clearPersistedFirstRunConfig).toHaveBeenCalledWith(
      fakes.loadedConfig,
      {
        stateRoot: STATE_DIR,
        authRoot: `${STATE_DIR}/auth`,
        owner: "runtime",
      },
    );
    expect(fakes.saveElizaConfig).toHaveBeenCalledWith(fakes.loadedConfig);
  });

  it("wipes the three Eliza Cloud vault keys", async () => {
    const { ctx, error } = makeCtx("POST", "/api/agent/reset", makeState());

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(fakes.vaultRemove).toHaveBeenCalledWith("ELIZAOS_CLOUD_API_KEY");
    expect(fakes.vaultRemove).toHaveBeenCalledWith("ELIZAOS_CLOUD_BASE_URL");
    expect(fakes.vaultRemove).toHaveBeenCalledWith("ELIZAOS_CLOUD_ENABLED");
    expect(error).not.toHaveBeenCalled();
  });

  it("continues when a single vault key is already missing", async () => {
    fakes.vaultRemove.mockImplementation(async (key: string) => {
      if (key === "ELIZAOS_CLOUD_BASE_URL") {
        throw new Error("not found");
      }
    });
    const { ctx, json, error, logWarn } = makeCtx(
      "POST",
      "/api/agent/reset",
      makeState(),
    );

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(fakes.vaultRemove).toHaveBeenCalledTimes(3);
    expect(error).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(ctx.res, { ok: true });
  });

  it("warns and still succeeds when the vault itself cannot be opened", async () => {
    fakes.sharedVault.mockImplementation(() => {
      throw new Error("vault sealed");
    });
    const { ctx, json, error, logWarn } = makeCtx(
      "POST",
      "/api/agent/reset",
      makeState(),
    );

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(ctx.res, { ok: true });
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Reset: failed to wipe cloud vault entries: vault sealed",
      ),
    );
  });

  it("stringifies a non-Error vault failure", async () => {
    fakes.getAgentHostBridge.mockImplementation(() => {
      throw "no-bridge";
    });
    const { ctx, json, logWarn } = makeCtx(
      "POST",
      "/api/agent/reset",
      makeState(),
    );

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(json).toHaveBeenCalledWith(ctx.res, { ok: true });
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Reset: failed to wipe cloud vault entries: no-bridge",
      ),
    );
  });

  it("uses the default style-preset name on reset when config has no agent name", async () => {
    fakes.loadedConfig.ui.assistant.name = "  ";
    fakes.loadedConfig.agents.list = [];
    const { ctx } = makeCtx("POST", "/api/agent/reset", makeState());

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(ctx.state.agentName).toBe(getDefaultStylePreset().name);
  });

  it("500s when runtime.stop throws", async () => {
    const runtime = fakeRuntime("Live");
    (
      runtime as unknown as { stop: ReturnType<typeof vi.fn> }
    ).stop.mockRejectedValue(new Error("already stopped"));
    const state = makeState({ runtime, agentState: "running" });
    const { ctx, json, error } = makeCtx("POST", "/api/agent/reset", state);

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Reset failed: already stopped",
      500,
    );
    expect(state.agentState).toBe("running");
  });

  it("500s with a stringified non-Error when loadElizaConfig throws", async () => {
    fakes.loadElizaConfig.mockImplementation(() => {
      throw "config missing";
    });
    const { ctx, json, error } = makeCtx(
      "POST",
      "/api/agent/reset",
      makeState({ runtime: null }),
    );

    await expect(handleAgentAdminRoutes(ctx)).resolves.toBe(true);

    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Reset failed: config missing",
      500,
    );
  });
});
