/**
 * Coverage for the PLUGIN action's manager-backed lifecycle ops
 * (install/uninstall/update/sync/eject/reinject), the local-API ops the
 * sibling plugin-toggle suite does not reach (configure/read_config/disconnect),
 * validate's op-resolution precedence, and the handler catch boundary.
 *
 * Harness: real module under test with only its process edges controlled. The
 * authorization case enters through executePlannedToolCall; `globalThis.fetch`
 * captures outbound requests, the restart handler uses @elizaos/shared's seam,
 * and ELIZA_PORT drives the real resolveServerOnlyPort resolver. The plugin
 * manager is a duck-typed fake that passes isPluginManagerLike.
 */

import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { executePlannedToolCall } from "@elizaos/core/runtime/execute-planned-tool-call";
import { setRestartHandler } from "@elizaos/shared";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import type {
  EjectResult,
  PluginInstallResult,
  PluginManagerLike,
  PluginUninstallResult,
  ReinjectResult,
  SyncResult,
} from "../services/plugin-manager-types.ts";
import { pluginAction } from "./plugin.ts";

const TEST_PORT = "46799";

interface CapturedRequest {
  url: string;
  method?: string;
  body: unknown;
  headers?: Record<string, string>;
}

interface StubResponseSpec {
  ok?: boolean;
  status?: number;
  payload?: unknown;
  failJson?: boolean;
}

function stubFetchSequence(responses: StubResponseSpec[]): {
  captured: CapturedRequest[];
  restore: () => void;
} {
  const captured: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const index = Math.min(captured.length, responses.length - 1);
    const spec = responses[index];
    captured.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      headers: init?.headers as Record<string, string> | undefined,
    });
    return {
      ok: spec.ok ?? true,
      status: spec.status ?? 200,
      json: spec.failJson
        ? async () => {
            throw new SyntaxError("Unexpected end of JSON input");
          }
        : async () => spec.payload,
    } as Response;
  }) as typeof fetch;
  return {
    captured,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function installOk(): PluginInstallResult {
  return {
    success: true,
    pluginName: "Discord",
    version: "1.4.0",
    installPath: "/plugins/discord",
    requiresRestart: true,
  };
}

function uninstallOk(): PluginUninstallResult {
  return { success: true, pluginName: "Discord", requiresRestart: false };
}

function updateOk(): PluginInstallResult {
  return {
    success: true,
    pluginName: "Discord",
    version: "1.5.0",
    installPath: "/plugins/discord",
    requiresRestart: true,
  };
}

function syncOk(): SyncResult {
  return {
    success: true,
    pluginName: "@elizaos/plugin-discord",
    ejectedPath: "/src/plugins/discord",
    requiresRestart: false,
  };
}

function ejectOk(): EjectResult {
  return {
    success: true,
    pluginName: "Discord",
    ejectedPath: "/src/plugins/discord",
    requiresRestart: true,
  };
}

function reinjectOk(): ReinjectResult {
  return {
    success: true,
    pluginName: "Discord",
    removedPath: "/src/plugins/discord",
    requiresRestart: true,
  };
}

function createManager(): PluginManagerLike {
  return {
    refreshRegistry: vi.fn(async () => new Map()),
    listInstalledPlugins: vi.fn(async () => []),
    getRegistryPlugin: vi.fn(async () => null),
    searchRegistry: vi.fn(async () => []),
    installPlugin: vi.fn(async () => installOk()),
    uninstallPlugin: vi.fn(async () => uninstallOk()),
    listEjectedPlugins: vi.fn(async () => []),
    ejectPlugin: vi.fn(async () => ejectOk()),
    syncPlugin: vi.fn(async () => syncOk()),
    reinjectPlugin: vi.fn(async () => reinjectOk()),
    updatePlugin: vi.fn(async () => updateOk()),
  } as unknown as PluginManagerLike;
}

const bareRuntime = {
  getService: () => null,
} as unknown as IAgentRuntime;

function runtimeWithManager(mgr: unknown): IAgentRuntime {
  return {
    getService: (name: string) => (name === "plugin_manager" ? mgr : null),
  } as unknown as IAgentRuntime;
}

function executorRuntime(action: Action): IAgentRuntime {
  return {
    actions: [action],
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    getRoom: vi.fn(async () => null),
    getService: vi.fn(() => null),
    reportError: vi.fn(),
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

function executorMessage(): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000002" as UUID,
    entityId: "00000000-0000-0000-0000-000000000003" as UUID,
    roomId: "00000000-0000-0000-0000-000000000004" as UUID,
    content: { text: "Configure the Discord connector." },
  } as Memory;
}

type HandlerParams = Record<string, unknown>;

// Every branch of pluginAction.handler returns a fully populated ActionResult;
// the Action interface types the handler as optional, so re-narrow here once.
type AssertedResult = ActionResult & {
  data: NonNullable<ActionResult["data"]>;
};

async function run(
  runtime: IAgentRuntime,
  parameters: HandlerParams,
): Promise<AssertedResult> {
  const result = await pluginAction.handler(
    runtime,
    { content: { text: "" } } as never,
    undefined,
    { parameters: parameters as never },
    undefined,
  );
  return result as AssertedResult;
}

async function validates(parameters: HandlerParams, runtime = bareRuntime) {
  return pluginAction.validate?.(
    runtime,
    { content: { text: "" } } as never,
    undefined,
    { parameters: parameters as never },
  );
}

function listPayload(plugins: unknown) {
  return { payload: { plugins } };
}

let restoreFetch: (() => void) | null = null;
let previousPortEnv: string | undefined;
let previousTokenEnv: string | undefined;

beforeEach(() => {
  previousPortEnv = process.env.ELIZA_PORT;
  previousTokenEnv = process.env.ELIZA_API_TOKEN;
  process.env.ELIZA_PORT = TEST_PORT;
  process.env.ELIZA_API_TOKEN = "self-api-token";
});

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  if (previousPortEnv === undefined) delete process.env.ELIZA_PORT;
  else process.env.ELIZA_PORT = previousPortEnv;
  if (previousTokenEnv === undefined) delete process.env.ELIZA_API_TOKEN;
  else process.env.ELIZA_API_TOKEN = previousTokenEnv;
  setRestartHandler(() => {});
  vi.useRealTimers();
});

describe("PLUGIN validate — op resolution and plugin_manager gating", () => {
  it("exposes the action when no operation is supplied yet", async () => {
    await expect(validates({})).resolves.toBe(true);
    await expect(validates({ pluginId: "discord" })).resolves.toBe(true);
  });

  it("exposes the action for every local-API op even without a manager", async () => {
    for (const op of [
      "configure",
      "read_config",
      "toggle",
      "list",
      "disconnect",
    ]) {
      await expect(validates({ action: op })).resolves.toBe(true);
    }
  });

  it("hides the action for each manager op while the service is absent or not manager-shaped", async () => {
    for (const op of [
      "install",
      "uninstall",
      "update",
      "sync",
      "eject",
      "reinject",
    ]) {
      await expect(validates({ action: op })).resolves.toBe(false);
      await expect(
        validates(
          { action: op },
          runtimeWithManager({ installPlugin: () => {} }),
        ),
      ).resolves.toBe(false);
    }
  });

  it("exposes the action for manager ops once a structurally valid manager is registered", async () => {
    for (const op of [
      "install",
      "uninstall",
      "update",
      "sync",
      "eject",
      "reinject",
    ]) {
      await expect(
        validates({ action: op }, runtimeWithManager(createManager())),
      ).resolves.toBe(true);
    }
  });

  it("resolves the op as action, then subaction, then op", async () => {
    // action wins over a lower-priority manager op.
    await expect(
      validates({ action: "toggle", subaction: "install", op: "eject" }),
    ).resolves.toBe(true);
    // subaction beats op.
    await expect(
      validates({ subaction: "install", op: "toggle" }),
    ).resolves.toBe(false);
    await expect(
      validates({ subaction: "toggle", op: "install" }),
    ).resolves.toBe(true);
    // bare op still reaches the gate.
    await expect(validates({ op: "sync" })).resolves.toBe(false);
  });
});

describe("PLUGIN executor authorization and self-API boundary", () => {
  it("denies non-owners before I/O and sends exact self-auth headers for an owner", async () => {
    const stub = stubFetchSequence([
      { payload: { ok: true } },
      { payload: { success: true, durationMs: 9 } },
    ]);
    restoreFetch = stub.restore;
    const realHandler = pluginAction.handler;
    if (!realHandler) throw new Error("PLUGIN handler is required");
    const handler = vi.fn(realHandler);
    const action = { ...pluginAction, handler };
    const runtime = executorRuntime(action);
    const toolCall = {
      name: "PLUGIN",
      params: {
        action: "configure",
        pluginId: "discord",
        config: { DISCORD_API_TOKEN: "synthetic-value" },
      },
    };

    const denied = await executePlannedToolCall(
      runtime,
      {
        message: executorMessage(),
        activeContexts: ["settings"],
        userRoles: ["MEMBER"],
      },
      toolCall,
    );

    expect(denied.success).toBe(false);
    expect(denied.error).toContain("not allowed for the current role");
    expect(handler).not.toHaveBeenCalled();
    expect(stub.captured).toHaveLength(0);

    const allowed = await executePlannedToolCall(
      runtime,
      {
        message: executorMessage(),
        activeContexts: ["settings"],
        userRoles: ["OWNER"],
      },
      toolCall,
    );

    expect(allowed.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(stub.captured.map((request) => request.headers)).toEqual([
      {
        "Content-Type": "application/json",
        Authorization: "Bearer self-api-token",
      },
      {
        "Content-Type": "application/json",
        Authorization: "Bearer self-api-token",
      },
    ]);
  });
});

describe("PLUGIN handler dispatch — invalid operations", () => {
  it("rejects a missing operation without touching the network or services", async () => {
    const mgr = createManager();
    const runtime = runtimeWithManager(mgr);
    const result = await run(runtime, {});

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ error: "PLUGIN_INVALID" });
    expect(result.text).toBe(
      "action is required and must be one of install, uninstall, update, sync, eject, reinject, configure, read_config, toggle, list, disconnect.",
    );
  });

  it("rejects an unsupported operation name", async () => {
    const result = await run(bareRuntime, { action: "restart" });

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ error: "PLUGIN_INVALID" });
  });

  it("fails each manager op with its own code when no manager service exists", async () => {
    for (const [op, code] of [
      ["install", "PLUGIN_INSTALL_FAILED"],
      ["uninstall", "PLUGIN_UNINSTALL_FAILED"],
      ["update", "PLUGIN_UPDATE_FAILED"],
      ["sync", "PLUGIN_SYNC_FAILED"],
      ["eject", "PLUGIN_EJECT_FAILED"],
      ["reinject", "PLUGIN_REINJECT_FAILED"],
    ] as const) {
      const result = await run(bareRuntime, {
        action: op,
        pluginId: "discord",
      });
      expect(result.success).toBe(false);
      expect(result.text).toBe("Plugin manager service is not available.");
      expect(result.data).toMatchObject({ error: code });
    }
  });
});

describe("PLUGIN install/uninstall via plugin_manager", () => {
  it("installs bare ids as scoped elizaos plugins and reports restart intent", async () => {
    const mgr = createManager();
    const result = await run(runtimeWithManager(mgr), {
      action: "install",
      pluginId: "discord",
    });

    expect(mgr.installPlugin).toHaveBeenCalledTimes(1);
    expect(mgr.installPlugin).toHaveBeenCalledWith("@elizaos/plugin-discord");
    expect(result.success).toBe(true);
    expect(result.text).toBe(
      "Plugin Discord@1.4.0 installed successfully. The agent will restart to load it.",
    );
    expect(result.data).toMatchObject({
      actionName: "PLUGIN",
      op: "install",
      pluginId: "discord",
      npmName: "@elizaos/plugin-discord",
      pluginName: "Discord",
      version: "1.4.0",
      installPath: "/plugins/discord",
      requiresRestart: true,
    });
  });

  it("passes already-scoped names through untouched", async () => {
    const mgr = createManager();
    await run(runtimeWithManager(mgr), {
      action: "install",
      pluginId: "@acme/custom-plugin",
    });

    expect(mgr.installPlugin).toHaveBeenCalledWith("@acme/custom-plugin");
  });

  it("falls back to connectorId and trims surrounding whitespace", async () => {
    const mgr = createManager();
    await run(runtimeWithManager(mgr), {
      action: "uninstall",
      pluginId: "   ",
      connectorId: "  telegram  ",
    });

    expect(mgr.uninstallPlugin).toHaveBeenCalledWith(
      "@elizaos/plugin-telegram",
    );
  });

  it("reports a failed install with the manager's error and a known fallback", async () => {
    const mgr = createManager();
    (mgr.installPlugin as Mock).mockResolvedValueOnce({
      success: false,
      pluginName: "",
      version: "",
      installPath: "",
      requiresRestart: false,
      error: "registry unreachable",
    });
    const result = await run(runtimeWithManager(mgr), {
      action: "install",
      pluginId: "discord",
    });

    expect(result.success).toBe(false);
    expect(result.text).toBe("Failed to install discord: registry unreachable");
    expect(result.data).toMatchObject({ error: "PLUGIN_INSTALL_FAILED" });
  });

  it('substitutes "unknown error" when a failed install carries no message', async () => {
    const mgr = createManager();
    (mgr.installPlugin as Mock).mockResolvedValueOnce({
      success: false,
      pluginName: "",
      version: "",
      installPath: "",
      requiresRestart: false,
    });
    const result = await run(runtimeWithManager(mgr), {
      action: "install",
      pluginId: "discord",
    });

    expect(result.text).toBe("Failed to install discord: unknown error");
  });

  it("omits the restart sentence when uninstall needs no restart", async () => {
    const mgr = createManager();
    (mgr.uninstallPlugin as Mock).mockResolvedValueOnce({
      success: true,
      pluginName: "Discord",
      requiresRestart: false,
    });
    const result = await run(runtimeWithManager(mgr), {
      action: "uninstall",
      pluginId: "discord",
    });

    expect(mgr.uninstallPlugin).toHaveBeenCalledWith("@elizaos/plugin-discord");
    expect(result.text).toBe("Plugin Discord uninstalled successfully.");
  });

  it("mentions the restart when uninstall drops a live plugin", async () => {
    const mgr = createManager();
    (mgr.uninstallPlugin as Mock).mockResolvedValueOnce({
      success: true,
      pluginName: "Discord",
      requiresRestart: true,
    });
    const result = await run(runtimeWithManager(mgr), {
      action: "uninstall",
      pluginId: "discord",
    });

    expect(result.text).toBe(
      "Plugin Discord uninstalled successfully. The agent will restart to drop it.",
    );
  });

  it("fails without any manager call when no target id resolves", async () => {
    const mgr = createManager();
    const result = await run(runtimeWithManager(mgr), { action: "install" });

    expect(mgr.installPlugin).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.text).toBe("Missing pluginId.");
    expect(result.data).toMatchObject({ error: "PLUGIN_INSTALL_FAILED" });
  });
});

describe("PLUGIN update via plugin_manager", () => {
  it("refuses updates when the manager predates updatePlugin", async () => {
    const mgr = createManager();
    delete (mgr as Partial<PluginManagerLike>).updatePlugin;
    const result = await run(runtimeWithManager(mgr), {
      action: "update",
      pluginId: "discord",
    });

    expect(result.success).toBe(false);
    expect(result.text).toBe("Plugin manager does not support updates.");
    expect(result.data).toMatchObject({ error: "PLUGIN_UPDATE_FAILED" });
  });

  it("updates without a stream by passing undefined options", async () => {
    const mgr = createManager();
    const result = await run(runtimeWithManager(mgr), {
      action: "update",
      pluginId: "discord",
    });

    expect(mgr.updatePlugin).toHaveBeenCalledTimes(1);
    expect(mgr.updatePlugin).toHaveBeenCalledWith(
      "@elizaos/plugin-discord",
      undefined,
      undefined,
    );
    expect(result.success).toBe(true);
    expect(result.text).toBe(
      "Plugin Discord@1.5.0 updated successfully. The agent will restart to load the new version.",
    );
    expect(result.data).toMatchObject({ op: "update", stream: undefined });
  });

  it("forwards an explicit release stream as the update options", async () => {
    const mgr = createManager();
    const result = await run(runtimeWithManager(mgr), {
      action: "update",
      pluginId: "discord",
      stream: "beta",
    });

    expect(mgr.updatePlugin).toHaveBeenCalledWith(
      "@elizaos/plugin-discord",
      undefined,
      { releaseStream: "beta" },
    );
    expect(result.data).toMatchObject({ stream: "beta" });
  });

  it("reports failed updates with the manager error", async () => {
    const mgr = createManager();
    (mgr.updatePlugin as Mock).mockResolvedValueOnce({
      success: false,
      pluginName: "",
      version: "",
      installPath: "",
      requiresRestart: false,
      error: "network down",
    });
    const result = await run(runtimeWithManager(mgr), {
      action: "update",
      pluginId: "discord",
    });

    expect(result.success).toBe(false);
    expect(result.text).toBe("Failed to update discord: network down");
    expect(result.data).toMatchObject({ error: "PLUGIN_UPDATE_FAILED" });
  });
});

describe("PLUGIN sync via plugin_manager", () => {
  it("hands the raw resolved id to syncPlugin and reports the synced name", async () => {
    const mgr = createManager();
    const result = await run(runtimeWithManager(mgr), {
      action: "sync",
      pluginId: "@fork/plugin-discord",
    });

    // sync deliberately does NOT normalize to @elizaos/* — the raw target is
    // forwarded so forked/ejected sources can be synced against upstream.
    expect(mgr.syncPlugin).toHaveBeenCalledWith("@fork/plugin-discord");
    expect(result.success).toBe(true);
    expect(result.text).toBe("Synced @elizaos/plugin-discord.");
    expect(result.data).toMatchObject({ op: "sync" });
  });

  it("ends the failure text with the deliberate trailing period", async () => {
    const mgr = createManager();
    (mgr.syncPlugin as Mock).mockResolvedValueOnce({
      success: false,
      pluginName: "",
      ejectedPath: "",
      requiresRestart: false,
      error: "merge conflict",
    });
    const result = await run(runtimeWithManager(mgr), {
      action: "sync",
      pluginId: "discord",
    });

    expect(result.text).toBe("Failed to sync discord: merge conflict.");
    expect(result.data).toMatchObject({ error: "PLUGIN_SYNC_FAILED" });
  });

  it("fails fast when no id resolves", async () => {
    const mgr = createManager();
    const result = await run(runtimeWithManager(mgr), { action: "sync" });

    expect(mgr.syncPlugin).not.toHaveBeenCalled();
    expect(result.text).toBe("Missing pluginId.");
    expect(result.data).toMatchObject({ error: "PLUGIN_SYNC_FAILED" });
  });
});

describe("PLUGIN eject/reinject schedule a delayed restart", () => {
  it("ejects, then requests a restart exactly one second later", async () => {
    vi.useFakeTimers();
    const restartSpy = vi.fn();
    setRestartHandler(restartSpy);
    const mgr = createManager();

    const before = Date.now();
    const result = await run(runtimeWithManager(mgr), {
      action: "eject",
      pluginId: "discord",
    });

    expect(mgr.ejectPlugin).toHaveBeenCalledWith("discord");
    expect(result.success).toBe(true);
    expect(result.text).toBe(
      "Ejected Discord to /src/plugins/discord. Restarting to load local source.",
    );
    // No synchronous restart: the timer has not fired.
    expect(restartSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(999);
    expect(restartSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(restartSpy).toHaveBeenCalledTimes(1);
    expect(restartSpy).toHaveBeenCalledWith("Plugin Discord ejected");
    expect(Date.now()).toBeGreaterThanOrEqual(before);
  });

  it("does not schedule a restart when ejection fails", async () => {
    vi.useFakeTimers();
    const restartSpy = vi.fn();
    setRestartHandler(restartSpy);
    const mgr = createManager();
    (mgr.ejectPlugin as Mock).mockResolvedValueOnce({
      success: false,
      pluginName: "",
      ejectedPath: "",
      requiresRestart: false,
      error: "git clone failed",
    });

    const result = await run(runtimeWithManager(mgr), {
      action: "eject",
      pluginId: "discord",
    });

    expect(result.text).toBe("Failed to eject discord: git clone failed");
    expect(result.data).toMatchObject({ error: "PLUGIN_EJECT_FAILED" });
    vi.advanceTimersByTime(5_000);
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it("reinjects, then restarts after one second with the reinject reason", async () => {
    vi.useFakeTimers();
    const restartSpy = vi.fn();
    setRestartHandler(restartSpy);
    const mgr = createManager();

    const result = await run(runtimeWithManager(mgr), {
      action: "reinject",
      pluginId: "discord",
    });

    expect(mgr.reinjectPlugin).toHaveBeenCalledWith("discord");
    expect(result.success).toBe(true);
    expect(result.text).toBe(
      "Removed ejected plugin Discord. Restarting to load npm version.",
    );
    expect(restartSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(restartSpy).toHaveBeenCalledWith("Plugin Discord reinjected");
  });

  it("leaves the restart unscheduled when reinjection fails", async () => {
    vi.useFakeTimers();
    const restartSpy = vi.fn();
    setRestartHandler(restartSpy);
    const mgr = createManager();
    (mgr.reinjectPlugin as Mock).mockRejectedValueOnce(new Error("npm broken"));

    const result = await run(runtimeWithManager(mgr), {
      action: "reinject",
      pluginId: "discord",
    });

    expect(result.success).toBe(false);
    expect(result.text).toBe("Failed to reinject: npm broken");
    expect(result.data).toMatchObject({ error: "PLUGIN_REINJECT_FAILED" });
    vi.advanceTimersByTime(5_000);
    expect(restartSpy).not.toHaveBeenCalled();
  });
});

describe("PLUGIN handler catch boundary", () => {
  it("translates thrown Errors into a typed failure", async () => {
    const mgr = createManager();
    (mgr.installPlugin as Mock).mockRejectedValueOnce(new Error("disk full"));
    const result = await run(runtimeWithManager(mgr), {
      action: "install",
      pluginId: "discord",
    });

    expect(result.success).toBe(false);
    expect(result.text).toBe("Failed to install: disk full");
    expect(result.data).toMatchObject({ error: "PLUGIN_INSTALL_FAILED" });
  });

  it("stringifies non-Error rejections instead of crashing", async () => {
    const mgr = createManager();
    (mgr.uninstallPlugin as Mock).mockRejectedValueOnce("exploded");
    const result = await run(runtimeWithManager(mgr), {
      action: "uninstall",
      pluginId: "discord",
    });

    expect(result.success).toBe(false);
    expect(result.text).toBe("Failed to uninstall: exploded");
    expect(result.data).toMatchObject({ error: "PLUGIN_UNINSTALL_FAILED" });
  });
});

describe("PLUGIN configure over the local compat API", () => {
  it("requires a resolvable target id before fetching", async () => {
    const stub = stubFetchSequence([{ payload: {} }]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, {
      action: "configure",
      config: { KEY: "value" },
    });

    expect(stub.captured).toHaveLength(0);
    expect(result.text).toBe("Missing pluginId.");
    expect(result.data).toMatchObject({ error: "PLUGIN_CONFIGURE_FAILED" });
  });

  it("rejects configs that normalize to nothing", async () => {
    const stub = stubFetchSequence([{ payload: {} }]);
    restoreFetch = stub.restore;
    for (const config of [
      null,
      ["not", "an", "object"],
      {},
      { ONLY_UNSUPPORTED: null },
      { OBJ_VALUE: { nested: true } },
      { "": "empty key dropped" },
    ]) {
      const result = await run(bareRuntime, {
        action: "configure",
        pluginId: "discord",
        config,
      });
      expect(result.success).toBe(false);
      expect(result.text).toBe("Missing or empty config object.");
      expect(result.data).toMatchObject({ error: "PLUGIN_CONFIGURE_FAILED" });
    }
    expect(stub.captured).toHaveLength(0);
  });

  it("PUTs normalized string values, auto-tests the connection, and sorts keys in text only", async () => {
    const stub = stubFetchSequence([
      { payload: { ok: true } },
      { payload: { success: true, durationMs: 123 } },
    ]);
    restoreFetch = stub.restore;

    const result = await run(bareRuntime, {
      action: "configure",
      pluginId: "@elizaos/plugin-discord",
      config: {
        DISCORD_API_TOKEN: "xyz",
        RETRIES: 3,
        VOICE: true,
        IGNORED_NULL: null,
        IGNORED_OBJECT: { a: 1 },
      },
    });

    expect(stub.captured).toHaveLength(2);
    expect(stub.captured[0].method).toBe("PUT");
    expect(stub.captured[0].url).toBe(
      `http://localhost:${TEST_PORT}/api/plugins/${encodeURIComponent("@elizaos/plugin-discord")}`,
    );
    expect(stub.captured[0].body).toEqual({
      config: {
        DISCORD_API_TOKEN: "xyz",
        RETRIES: "3",
        VOICE: "true",
      },
    });
    expect(stub.captured[0].headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer self-api-token",
    });
    expect(stub.captured[1].method).toBe("POST");
    expect(stub.captured[1].url).toBe(
      `http://localhost:${TEST_PORT}/api/plugins/${encodeURIComponent("@elizaos/plugin-discord")}/test`,
    );

    expect(result.success).toBe(true);
    expect(result.text).toBe(
      "Updated @elizaos/plugin-discord config (DISCORD_API_TOKEN, RETRIES, VOICE). Connection test passed (123ms).",
    );
    expect(result.data.updatedKeys).toEqual([
      "DISCORD_API_TOKEN",
      "RETRIES",
      "VOICE",
    ]);
    expect(result.data).toMatchObject({
      op: "configure",
      pluginId: "@elizaos/plugin-discord",
      ok: true,
    });
  });

  it("appends the restart note only when the save demands one", async () => {
    const stub = stubFetchSequence([
      { payload: { ok: true, requiresRestart: true } },
      { payload: { success: true } },
      { payload: { ok: true } },
      { payload: { success: true } },
    ]);
    restoreFetch = stub.restore;

    const withRestart = await run(bareRuntime, {
      action: "configure",
      pluginId: "discord",
      config: { TOKEN: "x" },
    });
    expect(withRestart.text).toContain(
      "The agent will restart to apply the change.",
    );

    const withoutRestart = await run(bareRuntime, {
      action: "configure",
      pluginId: "discord",
      config: { TOKEN: "y" },
    });
    expect(withoutRestart.text).not.toContain("restart");
  });

  it("prefers data.error, then data.message, then the status fallback on save failure", async () => {
    for (const [payload, status, expected] of [
      [{ error: "vault locked", message: "secondary" }, 500, "vault locked"],
      [{ message: "only message" }, 502, "only message"],
      [{}, 503, "Save failed (503)."],
    ] as const) {
      const stub = stubFetchSequence([{ ok: false, status, payload }]);
      restoreFetch = stub.restore;
      const result = await run(bareRuntime, {
        action: "configure",
        pluginId: "discord",
        config: { TOKEN: "x" },
      });
      expect(result.success).toBe(false);
      expect(result.text).toBe(
        `Failed to save config for discord: ${expected}`,
      );
      expect(result.data).toMatchObject({ error: "PLUGIN_CONFIGURE_FAILED" });
    }
  });

  it("treats explicit success:false and ok:false bodies as failures", async () => {
    for (const payload of [
      { success: false, error: "denied" },
      { ok: false },
    ]) {
      const stub = stubFetchSequence([{ payload }]);
      restoreFetch = stub.restore;
      const result = await run(bareRuntime, {
        action: "configure",
        pluginId: "discord",
        config: { TOKEN: "x" },
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "PLUGIN_CONFIGURE_FAILED" });
    }
  });

  it("rejects a probe-shaped success:true body from the config mutation route", async () => {
    const stub = stubFetchSequence([
      { payload: { success: true } },
      { payload: { success: true, durationMs: 42 } },
    ]);
    restoreFetch = stub.restore;

    const result = await run(bareRuntime, {
      action: "configure",
      pluginId: "discord",
      config: { TOKEN: "x" },
    });

    expect(result.success).toBe(false);
    expect(stub.captured).toHaveLength(1);
    expect(result.text).toBe(
      "Failed to save config for discord: Save returned an invalid success response.",
    );
  });

  it("fails closed on an invalid save body without running the connection probe", async () => {
    const stub = stubFetchSequence([
      { failJson: true },
      { payload: { success: true, durationMs: 42 } },
    ]);
    restoreFetch = stub.restore;

    const result = await run(bareRuntime, {
      action: "configure",
      pluginId: "discord",
      config: { TOKEN: "x" },
    });

    expect(result.success).toBe(false);
    expect(stub.captured).toHaveLength(1);
    expect(result.text).toBe(
      "Failed to save config for discord: Save returned an invalid success response.",
    );
    expect(result.data).toMatchObject({ error: "PLUGIN_CONFIGURE_FAILED" });
  });

  it("fails configure unless the connection probe explicitly succeeds", async () => {
    const cases: Array<{
      testResponse: StubResponseSpec;
      expectedReason: string;
    }> = [
      {
        testResponse: {
          payload: { success: false, error: "timeout reaching host" },
        },
        expectedReason: "timeout reaching host",
      },
      {
        testResponse: { payload: { success: false } },
        expectedReason: "invalid probe response",
      },
      {
        testResponse: { ok: false, status: 503, payload: {} },
        expectedReason: "HTTP 503",
      },
    ];
    for (const { testResponse, expectedReason } of cases) {
      const stub = stubFetchSequence([{ payload: { ok: true } }, testResponse]);
      restoreFetch = stub.restore;
      const result = await run(bareRuntime, {
        action: "configure",
        pluginId: "discord",
        config: { TOKEN: "x" },
      });
      expect(result.success).toBe(false);
      expect(result.text).toContain(
        `connection verification failed: ${expectedReason}.`,
      );
      expect(result.data).toMatchObject({
        error: "PLUGIN_CONFIGURE_FAILED",
        configApplied: true,
        connectionVerified: false,
      });
    }
  });

  it("fails configure when the connection probe transport throws", async () => {
    const original = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        } as Response;
      }
      throw new Error("probe socket closed");
    }) as unknown as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };

    const result = await run(bareRuntime, {
      action: "configure",
      pluginId: "discord",
      config: { TOKEN: "x" },
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain(
      "connection verification failed: probe socket closed.",
    );
    expect(result.data).toMatchObject({
      error: "PLUGIN_CONFIGURE_FAILED",
      configApplied: true,
      connectionVerified: false,
    });
  });

  it("accepts an explicitly successful connection probe", async () => {
    const stub = stubFetchSequence([
      { payload: { ok: true } },
      { payload: { success: true } },
    ]);
    restoreFetch = stub.restore;

    const result = await run(bareRuntime, {
      action: "configure",
      pluginId: "discord",
      config: { TOKEN: "x" },
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain("Connection test passed (0ms).");
  });
});

describe("PLUGIN read_config over the local compat API", () => {
  it("requires a target id before fetching", async () => {
    const stub = stubFetchSequence([listPayload([])]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, { action: "read_config" });

    expect(stub.captured).toHaveLength(0);
    expect(result.text).toBe("Missing pluginId.");
    expect(result.data).toMatchObject({ error: "PLUGIN_READ_CONFIG_FAILED" });
  });

  it("surfaces the HTTP status when the listing fails", async () => {
    const stub = stubFetchSequence([{ ok: false, status: 503, payload: {} }]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, {
      action: "read_config",
      pluginId: "discord",
    });

    expect(result.success).toBe(false);
    expect(result.text).toBe("Failed to fetch plugins list: HTTP 503");
    expect(result.data).toMatchObject({ error: "PLUGIN_READ_CONFIG_FAILED" });
  });

  it("prefers an exact id match over later partial matches", async () => {
    const stub = stubFetchSequence([
      listPayload([
        {
          id: "wrapped-discord",
          name: "Wrapper",
          enabled: false,
          configured: false,
          parameters: [],
        },
        {
          id: "discord",
          name: "Discord",
          enabled: true,
          configured: true,
          parameters: [],
        },
      ]),
    ]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, {
      action: "read_config",
      pluginId: "discord",
    });

    expect(String(result.text)).toContain("Plugin: Discord (discord)");
  });

  it("falls back to case-insensitive substring matches on id or name", async () => {
    const stub = stubFetchSequence([
      listPayload([
        {
          id: "comms",
          name: "Chat Bridge",
          enabled: true,
          configured: false,
          parameters: [],
        },
      ]),
    ]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, {
      action: "read_config",
      pluginId: "CHAT BRIDGE".toLowerCase(),
    });

    expect(result.success).toBe(true);
    expect(String(result.text)).toContain("Plugin: Chat Bridge (comms)");
  });

  it("reports a distinct not-found code when nothing matches", async () => {
    const stub = stubFetchSequence([listPayload([])]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, {
      action: "read_config",
      pluginId: "nope",
    });

    expect(result.success).toBe(false);
    expect(result.text).toBe('Plugin "nope" not found.');
    expect(result.data).toMatchObject({
      error: "PLUGIN_READ_CONFIG_NOT_FOUND",
    });
  });

  it("renders parameters with labels, masks sensitive values, and defaults missing fields", async () => {
    const stub = stubFetchSequence([
      listPayload([
        {
          id: "discord",
          name: "Discord",
          description: "The Discord connector.",
          enabled: true,
          configured: true,
          version: "1.4.0",
          loadError: null,
          parameters: [
            {
              key: "DISCORD_API_TOKEN",
              required: true,
              sensitive: true,
              isSet: true,
              currentValue: "super-secret-value",
            },
            {
              key: "RETRIES",
              isSet: true,
              currentValue: "4",
            },
            {
              key: "NICKNAME",
              isSet: true,
              currentValue: null,
            },
            {
              key: "OPTIONAL_FLAG",
            },
          ],
        },
      ]),
    ]);
    restoreFetch = stub.restore;

    const result = await run(bareRuntime, {
      action: "read_config",
      pluginId: "discord",
    });

    expect(result.success).toBe(true);
    const text = String(result.text);
    expect(text).toContain("Status: enabled | configured: true");
    expect(text).toContain("Version: 1.4.0");
    expect(text).toContain("Description: The Discord connector.");
    expect(text).not.toContain("Load error:");
    expect(text).toContain("\nParameters:");
    expect(text).toContain("  DISCORD_API_TOKEN [required] [sensitive] = ***");
    expect(text).not.toContain("super-secret-value");
    expect(text).toContain("  RETRIES = 4");
    expect(text).toContain("  NICKNAME = (empty)");
    expect(text).toContain("  OPTIONAL_FLAG (not set)");

    expect(result.values).toEqual({
      pluginId: "discord",
      enabled: true,
      configured: true,
    });
    const params = (
      result.data as { plugin: { parameters: Array<Record<string, unknown>> } }
    ).plugin.parameters;
    expect(params[0]).toEqual({
      key: "DISCORD_API_TOKEN",
      required: true,
      sensitive: true,
      isSet: true,
      currentValue: null,
    });
    expect(params[3]).toEqual({
      key: "OPTIONAL_FLAG",
      required: false,
      sensitive: false,
      isSet: false,
      currentValue: null,
    });
  });

  it("falls back to configKeys when no parameters exist", async () => {
    const stub = stubFetchSequence([
      listPayload([
        {
          id: "plain",
          name: "Plain",
          enabled: false,
          configured: false,
          parameters: [],
          configKeys: ["ALPHA", "BETA"],
        },
      ]),
    ]);
    restoreFetch = stub.restore;

    const result = await run(bareRuntime, {
      action: "read_config",
      pluginId: "plain",
    });

    const text = String(result.text);
    expect(text).toContain("Config keys: ALPHA, BETA");
    expect(text).not.toContain("Parameters:");
    expect(text).toContain("Status: disabled | configured: false");
  });
});

describe("PLUGIN toggle — remaining failure and restart branches", () => {
  it("refuses non-boolean enabled values without fetching", async () => {
    const stub = stubFetchSequence([{ payload: {} }]);
    restoreFetch = stub.restore;
    for (const enabled of ["true", null, 1]) {
      const result = await run(bareRuntime, {
        action: "toggle",
        pluginId: "discord",
        enabled,
      });
      expect(result.success).toBe(false);
      expect(result.text).toBe("Missing 'enabled' boolean parameter.");
      expect(result.data).toMatchObject({ error: "PLUGIN_TOGGLE_FAILED" });
    }
    expect(stub.captured).toHaveLength(0);
  });

  it("reports HTTP failures using enable/disable wording", async () => {
    const stub = stubFetchSequence([
      { ok: false, status: 500, payload: { message: "backend exploded" } },
    ]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, {
      action: "toggle",
      pluginId: "discord",
      enabled: false,
    });

    expect(result.success).toBe(false);
    expect(result.text).toBe("Failed to disable discord: backend exploded");
    expect(result.data).toMatchObject({ error: "PLUGIN_TOGGLE_FAILED" });
  });

  it("honors ok:false bodies as failures even on HTTP 200", async () => {
    const stub = stubFetchSequence([
      { payload: { ok: false, error: "locked" } },
    ]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, {
      action: "toggle",
      pluginId: "discord",
      enabled: true,
    });

    expect(result.success).toBe(false);
    expect(result.text).toBe("Failed to enable discord: locked");
  });

  it("rejects a probe-shaped success:true body from the toggle mutation route", async () => {
    const stub = stubFetchSequence([{ payload: { success: true } }]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, {
      action: "toggle",
      pluginId: "discord",
      enabled: true,
    });

    expect(result.success).toBe(false);
    expect(result.text).toBe(
      "Failed to enable discord: Toggle returned an invalid success response.",
    );
  });

  it("appends the restart note when the toggle demands one", async () => {
    const stub = stubFetchSequence([
      { payload: { ok: true, requiresRestart: true } },
    ]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, {
      action: "toggle",
      pluginId: "discord",
      enabled: true,
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe(
      "Plugin discord enabled. The agent will restart to apply the change.",
    );
  });
});

describe("PLUGIN list — scoping, top-level filters, and malformed payloads", () => {
  const roster = [
    {
      id: "discord",
      name: "Discord",
      description: "Chat connector.",
      enabled: true,
      configured: true,
      isActive: true,
      category: "connector",
      parameters: [],
    },
    {
      id: "telegram",
      name: "Telegram",
      description: "Messaging connector.",
      enabled: false,
      configured: false,
      isActive: false,
      category: "connector",
      parameters: [],
    },
    {
      id: "calendar",
      name: "Calendar",
      description: "Scheduling plugin.",
      enabled: true,
      configured: false,
      isActive: true,
      category: "productivity",
      parameters: [],
    },
  ];

  it("defaults to the connector scope and excludes other categories", async () => {
    const stub = stubFetchSequence([listPayload(roster)]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, { action: "list" });

    expect(result.success).toBe(true);
    expect(String(result.text)).toContain("Connectors (2):");
    expect(String(result.text)).not.toContain("Calendar");
  });

  it("includes every category when type=plugin", async () => {
    const stub = stubFetchSequence([listPayload(roster)]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, { action: "list", type: "plugin" });

    expect(String(result.text)).toContain("Plugins (3):");
  });

  it("applies search and configured filters supplied as top-level fields", async () => {
    const stub = stubFetchSequence([listPayload(roster)]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, {
      action: "list",
      type: "plugin",
      search: "  MESSAGING ",
      configured: false,
    });

    expect(result.data).toMatchObject({ count: 1, totalBeforeFilter: 3 });
    expect(String(result.text)).toContain("- Telegram [telegram]");
  });

  it("filters inactive entries and treats missing isActive as inactive", async () => {
    const stub = stubFetchSequence([
      listPayload([
        ...roster,
        {
          id: "ghost",
          name: "Ghost",
          description: "No activity field.",
          enabled: true,
          configured: true,
          category: "connector",
          parameters: [],
        },
      ]),
    ]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, {
      action: "list",
      filter: { status: "inactive" },
    });

    expect(result.data).toMatchObject({ count: 2 });
    const text = String(result.text);
    expect(text).toContain("- Telegram [telegram] (disabled, unconfigured)");
    expect(text).toContain("- Ghost [ghost]");
  });

  it.each([null, "not-an-array"])(
    "fails closed when the plugin list payload is malformed: %j",
    async (plugins) => {
      const stub = stubFetchSequence([listPayload(plugins)]);
      restoreFetch = stub.restore;
      const result = await run(bareRuntime, { action: "list" });

      expect(result.success).toBe(false);
      expect(String(result.text)).toBe(
        "Failed to list connectors: /api/plugins returned an invalid payload",
      );
      expect(result.data).toMatchObject({ error: "PLUGIN_LIST_FAILED" });
    },
  );

  it("describes a valid unfiltered empty view without claiming transport health", async () => {
    const stub = stubFetchSequence([listPayload([])]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, { action: "list" });

    expect(result.success).toBe(true);
    expect(String(result.text)).toBe(
      "No connectors match the requested filter (0 connectors exist but none are listed under this view). This is a filtered view, not a statement that none exist — retry with no filter to see every connector.",
    );
    expect(result.data).toMatchObject({ count: 0, totalBeforeFilter: 0 });
  });

  it("uses singular wording when exactly one entry exists before filtering", async () => {
    const stub = stubFetchSequence([
      listPayload([roster.find((entry) => entry.id === "discord")]),
    ]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, {
      action: "list",
      filter: { status: "disabled" },
    });

    expect(String(result.text)).toContain(
      "status=disabled; 1 connector exist before filtering",
    );
  });

  it("wraps listing transport failures into PLUGIN_LIST_FAILED", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("loopback refused");
    }) as unknown as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
    const rejected = await run(bareRuntime, { action: "list" });
    expect(rejected.success).toBe(false);
    expect(rejected.text).toBe("Failed to list connectors: loopback refused");
    expect(rejected.data).toMatchObject({ error: "PLUGIN_LIST_FAILED" });

    const failingStatus = stubFetchSequence([
      { ok: false, status: 502, payload: {} },
    ]);
    restoreFetch = failingStatus.restore;
    const badStatus = await run(bareRuntime, { action: "list" });
    expect(badStatus.success).toBe(false);
    expect(badStatus.text).toBe(
      "Failed to list connectors: /api/plugins returned 502",
    );
  });
});

describe("PLUGIN disconnect — connector-owned revocation endpoints", () => {
  it("routes known connectors to their dedicated endpoints without a body", async () => {
    const stub = stubFetchSequence([
      {
        payload: {
          connector: "telegram-account",
          state: "idle",
          detail: { status: "idle" },
        },
      },
    ]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, {
      action: "disconnect",
      connectorId: "TeLeGrAm",
    });

    expect(stub.captured).toHaveLength(1);
    expect(stub.captured[0].method).toBe("POST");
    expect(stub.captured[0].url).toBe(
      `http://localhost:${TEST_PORT}/api/setup/telegram-account/cancel`,
    );
    expect(stub.captured[0].body).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.text).toBe("Disconnected TeLeGrAm.");
    expect(result.data).toMatchObject({
      op: "disconnect",
      endpoint: "/api/setup/telegram-account/cancel",
    });
  });

  it("matches whatsapp and discord-local against their shipped route contracts", async () => {
    for (const [id, path, payload] of [
      ["whatsapp", "/api/whatsapp/disconnect", { ok: true }],
      [
        "discord-local",
        "/api/setup/discord/cancel",
        { connector: "discord", state: "idle" },
      ],
    ] as const) {
      const stub = stubFetchSequence([{ payload }]);
      restoreFetch = stub.restore;
      const result = await run(bareRuntime, {
        action: "disconnect",
        connectorId: id,
      });
      expect(stub.captured[0].url).toBe(`http://localhost:${TEST_PORT}${path}`);
      expect(result.success).toBe(true);
    }
  });

  it("rejects a success shape borrowed from a different connector route", async () => {
    for (const [connectorId, payload] of [
      ["telegram", { ok: true }],
      ["whatsapp", { connector: "telegram-account", state: "idle" }],
      ["discord-local", { ok: true }],
    ] as const) {
      const stub = stubFetchSequence([{ payload }]);
      restoreFetch = stub.restore;
      const result = await run(bareRuntime, {
        action: "disconnect",
        connectorId,
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({
        error: "PLUGIN_DISCONNECT_FAILED",
      });
    }
  });

  it("reports dedicated-endpoint failures with response detail", async () => {
    const stub = stubFetchSequence([
      {
        ok: false,
        status: 409,
        payload: { error: "session active elsewhere" },
      },
    ]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, {
      action: "disconnect",
      connectorId: "whatsapp",
    });

    expect(result.success).toBe(false);
    expect(result.text).toBe(
      "Failed to disconnect whatsapp: session active elsewhere",
    );
    expect(result.data).toMatchObject({ error: "PLUGIN_DISCONNECT_FAILED" });
  });

  it("refuses unknown connectors instead of treating plugin disable as revocation", async () => {
    const stub = stubFetchSequence([{ payload: { success: true } }]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, {
      action: "disconnect",
      connectorId: "custom-relay",
    });

    expect(stub.captured).toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.text).toBe(
      "Cannot disconnect custom-relay: no connector-owned revocation endpoint is registered. Disabling a plugin does not revoke credentials or terminate its session.",
    );
    expect(result.data).toMatchObject({
      error: "PLUGIN_DISCONNECT_UNSUPPORTED",
    });
  });

  it("requires an explicit success response from a dedicated endpoint", async () => {
    const stub = stubFetchSequence([{ payload: {} }]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, {
      action: "disconnect",
      connectorId: "whatsapp",
    });

    expect(result.success).toBe(false);
    expect(result.text).toBe(
      "Failed to disconnect whatsapp: Disconnect returned an invalid success response.",
    );
    expect(result.data).toMatchObject({ error: "PLUGIN_DISCONNECT_FAILED" });
  });

  it("requires a connector id before any request", async () => {
    const stub = stubFetchSequence([{ payload: {} }]);
    restoreFetch = stub.restore;
    const result = await run(bareRuntime, { action: "disconnect" });

    expect(stub.captured).toHaveLength(0);
    expect(result.text).toBe("Missing connector id.");
    expect(result.data).toMatchObject({ error: "PLUGIN_DISCONNECT_FAILED" });
  });
});
