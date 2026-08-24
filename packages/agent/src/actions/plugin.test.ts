/**
 * Coverage for the PLUGIN agent action (`actions/plugin.ts`) beyond the toggle
 * verb already pinned by `plugin-toggle.test.ts`. The real action object is
 * driven through its public `handler`/`validate` surface: package-lifecycle ops
 * run against an injected duck-typed plugin_manager service, while the local
 * `/api/plugins` compat routes are exercised by stubbing `fetch` at the network
 * boundary and asserting the request each op actually issues plus the rendered
 * ActionResult the model would see.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { setRestartHandler } from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EjectResult,
  PluginInstallResult,
  PluginManagerLike,
  PluginUninstallResult,
  ReinjectResult,
  SyncResult,
} from "../services/plugin-manager-types.ts";
import { pluginAction } from "./plugin.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeRuntime(manager: unknown = null): IAgentRuntime {
  return {
    getService: (name: string) =>
      name === "plugin_manager" ? manager : undefined,
  } as unknown as IAgentRuntime;
}

function installOk(): PluginInstallResult {
  return {
    success: true,
    pluginName: "@elizaos/plugin-calendar",
    version: "1.4.0",
    installPath: "/plugins/calendar",
    requiresRestart: true,
  };
}

function uninstallOk(): PluginUninstallResult {
  return {
    success: true,
    pluginName: "@elizaos/plugin-calendar",
    requiresRestart: false,
  };
}

function ejectOk(): EjectResult {
  return {
    success: true,
    pluginName: "@elizaos/plugin-calendar",
    ejectedPath: "/workspace/plugins/plugin-calendar",
    requiresRestart: false,
  };
}

function syncOk(): SyncResult {
  return {
    success: true,
    pluginName: "@elizaos/plugin-calendar",
    ejectedPath: "/workspace/plugins/plugin-calendar",
    requiresRestart: false,
  };
}

function reinjectOk(): ReinjectResult {
  return {
    success: true,
    pluginName: "@elizaos/plugin-calendar",
    removedPath: "/workspace/plugins/plugin-calendar",
    requiresRestart: false,
  };
}

type ManagerOverrides = Partial<{
  [K in keyof PluginManagerLike]: unknown;
}>;

function makeManager(overrides: ManagerOverrides = {}): PluginManagerLike {
  const base: PluginManagerLike = {
    refreshRegistry: async () => new Map(),
    listInstalledPlugins: async () => [],
    getRegistryPlugin: async () => null,
    searchRegistry: async () => [],
    installPlugin: async () => installOk(),
    uninstallPlugin: async () => uninstallOk(),
    listEjectedPlugins: async () => [],
    ejectPlugin: async () => ejectOk(),
    syncPlugin: async () => syncOk(),
    reinjectPlugin: async () => reinjectOk(),
  };
  return Object.assign(base, overrides);
}

interface CapturedRequest {
  url: string;
  method?: string;
  body: unknown;
  headers?: Record<string, unknown>;
}

interface StubResponse {
  status?: number;
  body?: unknown;
  reject?: Error;
}

function stubFetch(responses: StubResponse[] | StubResponse): {
  captured: CapturedRequest[];
  restore: () => void;
} {
  const queue = Array.isArray(responses) ? responses : [responses];
  const captured: CapturedRequest[] = [];
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const response = queue[Math.min(index, queue.length - 1)] ?? undefined;
    index += 1;
    if (response?.reject) throw response.reject;
    const status = response?.status ?? 200;
    captured.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      headers: init?.headers as Record<string, unknown> | undefined,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response?.body ?? {},
    } as Response;
  }) as typeof fetch;
  return {
    captured,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function runHandler(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
) {
  return pluginAction.handler(
    runtime,
    { content: { text: "" } } as never,
    undefined,
    { parameters } as never,
    undefined,
  );
}

function listEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry",
    name: "Entry",
    description: "A plugin entry",
    enabled: true,
    configured: true,
    parameters: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  setRestartHandler(() => {});
});

// ---------------------------------------------------------------------------
// Dispatch and op validation
// ---------------------------------------------------------------------------

describe("PLUGIN handler dispatch", () => {
  it("rejects a call with no operation and enumerates the valid ops", async () => {
    const result = await runHandler(makeRuntime(), {});

    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ error: "PLUGIN_INVALID" });
    expect(String(result?.text)).toContain(
      "install, uninstall, update, sync, eject, reinject",
    );
  });

  it("rejects an unknown operation with PLUGIN_INVALID", async () => {
    const result = await runHandler(makeRuntime(), { action: "explode" });

    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ error: "PLUGIN_INVALID" });
  });

  it("routes through the `op` alias into the manager-gated install branch", async () => {
    const result = await runHandler(makeRuntime(), { op: "install" });

    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ error: "PLUGIN_INSTALL_FAILED" });
    expect(String(result?.text)).toContain(
      "Plugin manager service is not available.",
    );
  });

  it("routes through the `subaction` alias into the uninstall branch", async () => {
    const result = await runHandler(makeRuntime(), {
      subaction: "uninstall",
    });

    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ error: "PLUGIN_UNINSTALL_FAILED" });
    expect(String(result?.text)).toContain(
      "Plugin manager service is not available.",
    );
  });

  it("turns a throwing manager call into a typed ActionResult instead of an escaping exception", async () => {
    const mgr = makeManager({
      installPlugin: vi.fn(async () => {
        throw new Error("registry offline");
      }),
    });
    const result = await runHandler(makeRuntime(mgr), {
      action: "install",
      pluginId: "calendar",
    });

    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ error: "PLUGIN_INSTALL_FAILED" });
    expect(String(result?.text)).toContain("registry offline");
  });
});

describe("PLUGIN validate gating", () => {
  it("allows a manager op when the runtime exposes a conforming plugin_manager", async () => {
    const ok = await pluginAction.validate?.(
      makeRuntime(makeManager()),
      { content: { text: "install calendar" } } as never,
      undefined,
      { parameters: { action: "install" } },
    );
    expect(ok).toBe(true);
  });

  it("refuses a manager op when the registered service fails the duck-type guard", async () => {
    const partialService = { installPlugin: async () => installOk() };
    const ok = await pluginAction.validate?.(
      makeRuntime(partialService),
      { content: { text: "install calendar" } } as never,
      undefined,
      { parameters: { action: "install" } },
    );
    expect(ok).toBe(false);
  });

  it("allows non-manager ops and parameterless turns regardless of the service", async () => {
    const runtime = makeRuntime(null);
    await expect(
      pluginAction.validate?.(
        runtime,
        { content: { text: "list plugins" } } as never,
        undefined,
        { parameters: { action: "configure" } },
      ),
    ).resolves.toBe(true);
    await expect(
      pluginAction.validate?.(
        runtime,
        { content: { text: "hello" } } as never,
        undefined,
        undefined,
      ),
    ).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Package-lifecycle ops through the plugin_manager seam
// ---------------------------------------------------------------------------

describe("PLUGIN install through the manager", () => {
  it("fails before touching the manager when no target id is given", async () => {
    const installPlugin = vi.fn(async () => installOk());
    const mgr = makeManager({ installPlugin });

    const result = await runHandler(makeRuntime(mgr), {
      action: "install",
    });

    expect(installPlugin).not.toHaveBeenCalled();
    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ error: "PLUGIN_INSTALL_FAILED" });
    expect(String(result?.text)).toContain("Missing pluginId.");
  });

  it("normalizes a bare name to the @elizaos/plugin- scope and trims whitespace", async () => {
    const installPlugin = vi.fn(async (_name: string) => installOk());
    const mgr = makeManager({ installPlugin });

    const result = await runHandler(makeRuntime(mgr), {
      action: "install",
      pluginId: "  calendar  ",
    });

    expect(installPlugin.mock.calls[0]?.[0]).toBe("@elizaos/plugin-calendar");
    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      op: "install",
      pluginId: "calendar",
      npmName: "@elizaos/plugin-calendar",
    });
  });

  it("passes an already-scoped npm name through unchanged", async () => {
    const installPlugin = vi.fn(async (_name: string) => installOk());
    const mgr = makeManager({ installPlugin });

    await runHandler(makeRuntime(mgr), {
      action: "install",
      pluginId: "@acme/plugin-custom",
    });

    expect(installPlugin.mock.calls[0]?.[0]).toBe("@acme/plugin-custom");
  });

  it("falls back to connectorId when pluginId is absent", async () => {
    const installPlugin = vi.fn(async (_name: string) => installOk());
    const mgr = makeManager({ installPlugin });

    const result = await runHandler(makeRuntime(mgr), {
      action: "install",
      connectorId: "discord",
    });

    expect(installPlugin.mock.calls[0]?.[0]).toBe("@elizaos/plugin-discord");
    expect(result?.data).toMatchObject({ pluginId: "discord" });
  });

  it("reports name@version and appends the restart note when required", async () => {
    const mgr = makeManager();
    const result = await runHandler(makeRuntime(mgr), {
      action: "install",
      pluginId: "calendar",
    });

    const text = String(result?.text);
    expect(text).toContain(
      "Plugin @elizaos/plugin-calendar@1.4.0 installed successfully.",
    );
    expect(text).toContain("The agent will restart to load it.");
  });

  it("surfaces the manager's error on a failed install", async () => {
    const mgr = makeManager({
      installPlugin: async () => ({
        success: false,
        pluginName: "",
        version: "",
        installPath: "",
        error: "version not found",
        requiresRestart: false,
      }),
    });
    const result = await runHandler(makeRuntime(mgr), {
      action: "install",
      pluginId: "calendar",
    });

    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ error: "PLUGIN_INSTALL_FAILED" });
    const text = String(result?.text);
    expect(text).toContain("Failed to install calendar");
    expect(text).toContain("version not found");
  });
});

describe("PLUGIN uninstall through the manager", () => {
  it("reports success without a restart note when none is required", async () => {
    const mgr = makeManager({
      uninstallPlugin: async () => uninstallOk(),
    });
    const result = await runHandler(makeRuntime(mgr), {
      action: "uninstall",
      pluginId: "calendar",
    });

    expect(result?.success).toBe(true);
    expect(String(result?.text)).toBe(
      "Plugin @elizaos/plugin-calendar uninstalled successfully.",
    );
    expect(result?.data).toMatchObject({ op: "uninstall" });
  });

  it("appends the drop-it restart note when the manager requires a restart", async () => {
    const mgr = makeManager({
      uninstallPlugin: async () => ({
        success: true,
        pluginName: "@elizaos/plugin-calendar",
        requiresRestart: true,
      }),
    });
    const result = await runHandler(makeRuntime(mgr), {
      action: "uninstall",
      pluginId: "calendar",
    });

    expect(String(result?.text)).toContain(
      "The agent will restart to drop it.",
    );
  });

  it("propagates the manager's failure detail", async () => {
    const mgr = makeManager({
      uninstallPlugin: async () => ({
        success: false,
        pluginName: "",
        requiresRestart: false,
        error: "not installed",
      }),
    });
    const result = await runHandler(makeRuntime(mgr), {
      action: "uninstall",
      pluginId: "calendar",
    });

    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ error: "PLUGIN_UNINSTALL_FAILED" });
    expect(String(result?.text)).toContain("not installed");
  });
});

describe("PLUGIN update through the manager", () => {
  it("refuses updates when the manager predates the optional updatePlugin method", async () => {
    const mgr = makeManager();
    delete mgr.updatePlugin;

    const result = await runHandler(makeRuntime(mgr), {
      action: "update",
      pluginId: "calendar",
    });

    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ error: "PLUGIN_UPDATE_FAILED" });
    expect(String(result?.text)).toContain(
      "Plugin manager does not support updates.",
    );
  });

  it("forwards the release stream as update options and echoes it back", async () => {
    const updatePlugin = vi.fn(
      async (_name: string, _onProgress?: unknown, _options?: unknown) =>
        installOk(),
    );
    const mgr = makeManager({ updatePlugin });

    const result = await runHandler(makeRuntime(mgr), {
      action: "update",
      pluginId: "calendar",
      stream: "beta",
    });

    expect(updatePlugin.mock.calls[0]).toEqual([
      "@elizaos/plugin-calendar",
      undefined,
      { releaseStream: "beta" },
    ]);
    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({ stream: "beta" });
    expect(String(result?.text)).toContain(
      "@elizaos/plugin-calendar@1.4.0 updated successfully.",
    );
  });

  it("omits the options argument when no stream was requested", async () => {
    const updatePlugin = vi.fn(
      async (_name: string, _onProgress?: unknown, _options?: unknown) =>
        installOk(),
    );
    const mgr = makeManager({ updatePlugin });

    await runHandler(makeRuntime(mgr), {
      action: "update",
      pluginId: "calendar",
    });

    expect(updatePlugin.mock.calls[0]).toEqual([
      "@elizaos/plugin-calendar",
      undefined,
      undefined,
    ]);
  });
});

describe("PLUGIN sync / eject / reinject through the manager", () => {
  it("syncs the raw id without npm-name normalization", async () => {
    const syncPlugin = vi.fn(async (_id: string) => syncOk());
    const mgr = makeManager({ syncPlugin });

    const result = await runHandler(makeRuntime(mgr), {
      action: "sync",
      pluginId: "my-ejected-fork",
    });

    expect(syncPlugin.mock.calls[0]?.[0]).toBe("my-ejected-fork");
    expect(result?.success).toBe(true);
    expect(String(result?.text)).toContain("Synced @elizaos/plugin-calendar.");
  });

  it("surfaces sync failures with the trailing detail", async () => {
    const mgr = makeManager({
      syncPlugin: async () => ({
        success: false,
        pluginName: "",
        ejectedPath: "",
        error: "dirty worktree",
        requiresRestart: false,
      }),
    });
    const result = await runHandler(makeRuntime(mgr), {
      action: "sync",
      pluginId: "my-ejected-fork",
    });

    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ error: "PLUGIN_SYNC_FAILED" });
    expect(String(result?.text)).toContain("dirty worktree");
  });

  it("eject reports the local path and schedules a host restart", async () => {
    vi.useFakeTimers();
    const reasons: (string | undefined)[] = [];
    setRestartHandler((reason) => {
      reasons.push(reason);
    });

    const mgr = makeManager();
    const result = await runHandler(makeRuntime(mgr), {
      action: "eject",
      pluginId: "calendar",
    });

    expect(result?.success).toBe(true);
    expect(String(result?.text)).toContain(
      "Ejected @elizaos/plugin-calendar to /workspace/plugins/plugin-calendar.",
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(reasons).toHaveLength(1);
    expect(String(reasons[0])).toContain(
      "Plugin @elizaos/plugin-calendar ejected",
    );
  });

  it("surfaces eject failures", async () => {
    const mgr = makeManager({
      ejectPlugin: async () => ({
        success: false,
        pluginName: "",
        ejectedPath: "",
        error: "git clone failed",
        requiresRestart: false,
      }),
    });
    const result = await runHandler(makeRuntime(mgr), {
      action: "eject",
      pluginId: "calendar",
    });

    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ error: "PLUGIN_EJECT_FAILED" });
    expect(String(result?.text)).toContain("git clone failed");
  });

  it("reinject confirms removal of the ejected copy", async () => {
    const reinjectPlugin = vi.fn(async (_id: string) => reinjectOk());
    const mgr = makeManager({ reinjectPlugin });

    const result = await runHandler(makeRuntime(mgr), {
      action: "reinject",
      pluginId: "calendar",
    });

    expect(reinjectPlugin.mock.calls[0]?.[0]).toBe("calendar");
    expect(result?.success).toBe(true);
    expect(String(result?.text)).toContain(
      "Removed ejected plugin @elizaos/plugin-calendar.",
    );
  });
});

// ---------------------------------------------------------------------------
// Local compat-route ops (/api/plugins/*)
// ---------------------------------------------------------------------------

describe("PLUGIN configure against the local API", () => {
  it("fails before any request when config is missing, empty, or not an object", async () => {
    const { captured, restore } = stubFetch([{ body: {} }]);
    try {
      for (const config of [undefined, {}, ["nope"]]) {
        const result = await runHandler(makeRuntime(), {
          action: "configure",
          pluginId: "discord",
          config,
        });
        expect(result?.success).toBe(false);
        expect(result?.data).toMatchObject({
          error: "PLUGIN_CONFIGURE_FAILED",
        });
      }
      expect(captured).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("PUTs stringified key/value pairs and reports the sorted updated keys", async () => {
    const { captured, restore } = stubFetch([
      { body: { success: true } },
      { body: { success: true, durationMs: 42 } },
    ]);
    try {
      const result = await runHandler(makeRuntime(), {
        action: "configure",
        pluginId: "discord",
        config: {
          VERBOSE: true,
          DISCORD_API_TOKEN: 12345,
          MODE: "fast",
        },
      });

      expect(captured[0]?.method).toBe("PUT");
      expect(captured[0]?.url).toMatch(/\/api\/plugins\/discord$/);
      expect(captured[0]?.body).toEqual({
        config: {
          VERBOSE: "true",
          DISCORD_API_TOKEN: "12345",
          MODE: "fast",
        },
      });
      expect(String(result?.text)).toContain(
        "Updated discord config (DISCORD_API_TOKEN, MODE, VERBOSE).",
      );
    } finally {
      restore();
    }
  });

  it("runs the best-effort connection test and appends its outcome", async () => {
    const passing = stubFetch([
      { body: { success: true } },
      { body: { success: true, durationMs: 250 } },
    ]);
    try {
      const ok = await runHandler(makeRuntime(), {
        action: "configure",
        pluginId: "discord",
        config: { TOKEN: "x" },
      });
      expect(ok?.success).toBe(true);
      expect(String(ok?.text)).toContain("Connection test passed (250ms).");
      expect(passing.captured[1]?.method).toBe("POST");
      expect(passing.captured[1]?.url).toMatch(
        /\/api\/plugins\/discord\/test$/,
      );
    } finally {
      passing.restore();
    }

    const failing = stubFetch([
      { body: { success: true } },
      { body: { success: false, error: "bad credentials" } },
    ]);
    try {
      const failed = await runHandler(makeRuntime(), {
        action: "configure",
        pluginId: "discord",
        config: { TOKEN: "x" },
      });
      expect(String(failed?.text)).toContain(
        "Connection test failed: bad credentials.",
      );
    } finally {
      failing.restore();
    }
  });

  it("prefers the server's error message and falls back to the HTTP status", async () => {
    const detailed = stubFetch([
      { status: 400, body: { ok: false, error: "vault locked" } },
    ]);
    try {
      const result = await runHandler(makeRuntime(), {
        action: "configure",
        pluginId: "discord",
        config: { TOKEN: "x" },
      });
      expect(result?.success).toBe(false);
      expect(String(result?.text)).toContain("vault locked");
    } finally {
      detailed.restore();
    }

    const opaque = stubFetch([{ status: 500, body: {} }]);
    try {
      const result = await runHandler(makeRuntime(), {
        action: "configure",
        pluginId: "discord",
        config: { TOKEN: "x" },
      });
      expect(String(result?.text)).toContain("Save failed (500).");
    } finally {
      opaque.restore();
    }
  });

  it("appends the restart note when the save requires a restart", async () => {
    const { restore } = stubFetch([
      { body: { success: true, requiresRestart: true } },
      { body: {} },
    ]);
    try {
      const result = await runHandler(makeRuntime(), {
        action: "configure",
        pluginId: "discord",
        config: { TOKEN: "x" },
      });
      expect(String(result?.text)).toContain(
        "The agent will restart to apply the change.",
      );
    } finally {
      restore();
    }
  });
});

describe("PLUGIN read_config against the local API", () => {
  const entryFor = (overrides: Record<string, unknown>) =>
    listEntry({ id: "x", name: "X", ...overrides });

  it("fails with the HTTP status when the roster cannot be fetched", async () => {
    const { restore } = stubFetch([{ status: 503, body: {} }]);
    try {
      const result = await runHandler(makeRuntime(), {
        action: "read_config",
        pluginId: "discord",
      });
      expect(result?.success).toBe(false);
      expect(result?.data).toMatchObject({
        error: "PLUGIN_READ_CONFIG_FAILED",
      });
      expect(String(result?.text)).toContain("HTTP 503");
    } finally {
      restore();
    }
  });

  it("prefers an exact id match over an earlier substring candidate", async () => {
    const { restore } = stubFetch({
      body: {
        plugins: [
          entryFor({
            id: "@elizaos/plugin-discord-tool",
            name: "Discord Tool",
          }),
          entryFor({
            id: "@elizaos/plugin-discord",
            name: "Discord",
          }),
        ],
      },
    });
    try {
      const result = await runHandler(makeRuntime(), {
        action: "read_config",
        pluginId: "@elizaos/plugin-discord",
      });
      expect(result?.success).toBe(true);
      expect(result?.data).toMatchObject({
        op: "read_config",
        plugin: { id: "@elizaos/plugin-discord" },
      });
    } finally {
      restore();
    }
  });

  it("matches case-insensitively on id or name when no exact match exists", async () => {
    const byName = stubFetch({
      body: {
        plugins: [entryFor({ id: "telegram", name: "Telegram Connector" })],
      },
    });
    try {
      const result = await runHandler(makeRuntime(), {
        action: "read_config",
        pluginId: "TELEGRAM",
      });
      expect(result?.success).toBe(true);
      expect(result?.values).toEqual({
        pluginId: "telegram",
        enabled: true,
        configured: true,
      });
    } finally {
      byName.restore();
    }
  });

  it("reports a distinct not-found error instead of guessing a plugin", async () => {
    const { restore } = stubFetch({
      body: { plugins: [entryFor({})] },
    });
    try {
      const result = await runHandler(makeRuntime(), {
        action: "read_config",
        pluginId: "nonexistent",
      });
      expect(result?.success).toBe(false);
      expect(result?.data).toMatchObject({
        error: "PLUGIN_READ_CONFIG_NOT_FOUND",
      });
      expect(String(result?.text)).toContain('Plugin "nonexistent" not found.');
    } finally {
      restore();
    }
  });

  it("masks sensitive parameter values in text and data alike", async () => {
    const { restore } = stubFetch({
      body: {
        plugins: [
          entryFor({
            version: "2.0.0",
            loadError: "stale build",
            parameters: [
              {
                key: "API_TOKEN",
                required: true,
                sensitive: true,
                isSet: true,
                currentValue: "super-secret",
              },
              { key: "MODE", isSet: false },
            ],
          }),
        ],
      },
    });
    try {
      const result = await runHandler(makeRuntime(), {
        action: "read_config",
        pluginId: "x",
      });

      const text = String(result?.text);
      expect(text).toContain("Version: 2.0.0");
      expect(text).toContain("Load error: stale build");
      expect(text).toContain("***");
      expect(text).toContain("(not set)");
      expect(text).toContain("[required]");
      expect(text).toContain("[sensitive]");
      expect(text).not.toContain("super-secret");

      const plugin = (result?.data as { plugin: { parameters: unknown[] } })
        ?.plugin;
      expect(plugin.parameters[0]).toEqual({
        key: "API_TOKEN",
        required: true,
        sensitive: true,
        isSet: true,
        currentValue: null,
      });
    } finally {
      restore();
    }
  });

  it("falls back to listing config keys when no parameter metadata exists", async () => {
    const { restore } = stubFetch({
      body: {
        plugins: [entryFor({ parameters: [], configKeys: ["ALPHA", "BETA"] })],
      },
    });
    try {
      const result = await runHandler(makeRuntime(), {
        action: "read_config",
        pluginId: "x",
      });
      expect(String(result?.text)).toContain("Config keys: ALPHA, BETA");
    } finally {
      restore();
    }
  });
});

describe("PLUGIN disconnect against the local API", () => {
  it("uses telegram's dedicated account-cancel endpoint", async () => {
    const { captured, restore } = stubFetch([
      { body: { ok: true, message: "Signed out of telegram." } },
    ]);
    try {
      const result = await runHandler(makeRuntime(), {
        action: "disconnect",
        connectorId: "telegram",
      });

      expect(captured[0]?.method).toBe("POST");
      expect(captured[0]?.url).toMatch(
        /\/api\/setup\/telegram-account\/cancel$/,
      );
      expect(String(result?.text)).toBe("Signed out of telegram.");
      expect(result?.data).toMatchObject({
        op: "disconnect",
        endpoint: "/api/setup/telegram-account/cancel",
      });
    } finally {
      restore();
    }
  });

  it("uses whatsapp's dedicated disconnect endpoint", async () => {
    const { captured, restore } = stubFetch([{ body: { ok: true } }]);
    try {
      await runHandler(makeRuntime(), {
        action: "disconnect",
        connectorId: "whatsapp",
      });
      expect(captured[0]?.url).toMatch(/\/api\/whatsapp\/disconnect$/);
    } finally {
      restore();
    }
  });

  it("falls back to disabling unknown connectors so their sender stops", async () => {
    const { captured, restore } = stubFetch([{ body: { success: true } }]);
    try {
      const result = await runHandler(makeRuntime(), {
        action: "disconnect",
        connectorId: "custom-relay",
      });

      expect(captured[0]?.method).toBe("PUT");
      expect(captured[0]?.url).toMatch(/\/api\/plugins\/custom-relay$/);
      expect(captured[0]?.body).toEqual({ enabled: false });
      expect(result?.data).toMatchObject({ fallback: "plugin-disable" });
      expect(String(result?.text)).toContain("by disabling the connector.");
    } finally {
      restore();
    }
  });

  it("surfaces a dedicated-endpoint failure", async () => {
    const { restore } = stubFetch([
      { status: 503, body: { error: "telegram api down" } },
    ]);
    try {
      const result = await runHandler(makeRuntime(), {
        action: "disconnect",
        connectorId: "telegram",
      });
      expect(result?.success).toBe(false);
      expect(result?.data).toMatchObject({
        error: "PLUGIN_DISCONNECT_FAILED",
      });
      expect(String(result?.text)).toContain("telegram api down");
    } finally {
      restore();
    }
  });
});

describe("PLUGIN list scoping and filters", () => {
  const roster = [
    listEntry({ id: "alpha", name: "Alpha", category: "connector" }),
    listEntry({
      id: "beta",
      name: "Beta",
      category: "connector",
      enabled: false,
      isActive: true,
    }),
  ];

  it("defaults to the connector view and drops uncategorized plugins", async () => {
    const { restore } = stubFetch({
      body: {
        plugins: [...roster, listEntry({ id: "core-lib", name: "Core Lib" })],
      },
    });
    try {
      const result = await runHandler(makeRuntime(), {
        action: "list",
      });

      expect(result?.data).toMatchObject({
        type: "connector",
        count: 2,
        totalBeforeFilter: 2,
      });
      expect(String(result?.text)).toContain("Connectors (2):");
      expect(String(result?.text)).not.toContain("core-lib");
    } finally {
      restore();
    }
  });

  it("lists every plugin regardless of category when type=plugin", async () => {
    const { restore } = stubFetch({
      body: {
        plugins: [...roster, listEntry({ id: "core-lib", name: "Core Lib" })],
      },
    });
    try {
      const result = await runHandler(makeRuntime(), {
        action: "list",
        type: "plugin",
      });

      expect(result?.data).toMatchObject({
        type: "plugin",
        count: 3,
      });
      expect(String(result?.text)).toContain("Plugins (3):");
    } finally {
      restore();
    }
  });

  it("filters case-insensitively across id, name, and description", async () => {
    const { restore } = stubFetch({
      body: {
        plugins: [
          listEntry({ id: "gamma", name: "Gamma" }),
          listEntry({
            id: "delta",
            name: "Delta",
            description: "carries GAMMA relay support",
          }),
          listEntry({ id: "epsilon", name: "Epsilon" }),
        ],
      },
    });
    try {
      const result = await runHandler(makeRuntime(), {
        action: "list",
        type: "plugin",
        filter: { search: "  GAMMA  " },
      });

      expect(result?.data).toMatchObject({ count: 2 });
      const ids = (result?.data as { entries: { id: string }[] })?.entries.map(
        (entry) => entry.id,
      );
      expect(ids).toEqual(["gamma", "delta"]);
    } finally {
      restore();
    }
  });

  it("narrows by configured state in both directions", async () => {
    const configuredOnly = stubFetch({
      body: {
        plugins: [
          listEntry({ id: "set" }),
          listEntry({ id: "unset", configured: false }),
        ],
      },
    });
    try {
      const result = await runHandler(makeRuntime(), {
        action: "list",
        type: "plugin",
        filter: { configured: true },
      });
      const ids = (result?.data as { entries: { id: string }[] })?.entries.map(
        (entry) => entry.id,
      );
      expect(ids).toEqual(["set"]);
    } finally {
      configuredOnly.restore();
    }

    const unconfiguredOnly = stubFetch({
      body: {
        plugins: [
          listEntry({ id: "set" }),
          listEntry({ id: "unset", configured: false }),
        ],
      },
    });
    try {
      const result = await runHandler(makeRuntime(), {
        action: "list",
        type: "plugin",
        filter: { configured: false },
      });
      const ids = (result?.data as { entries: { id: string }[] })?.entries.map(
        (entry) => entry.id,
      );
      expect(ids).toEqual(["unset"]);
    } finally {
      unconfiguredOnly.restore();
    }
  });

  it("treats a missing isActive flag as inactive", async () => {
    const { restore } = stubFetch({
      body: { plugins: roster },
    });
    try {
      const result = await runHandler(makeRuntime(), {
        action: "list",
        type: "connector",
        filter: { status: "inactive" },
      });

      expect(result?.data).toMatchObject({ count: 1 });
      const ids = (result?.data as { entries: { id: string }[] })?.entries.map(
        (entry) => entry.id,
      );
      expect(ids).toEqual(["alpha"]);
    } finally {
      restore();
    }
  });

  it("renders line items with status, activity, and configuration markers", async () => {
    const { restore } = stubFetch({
      body: {
        plugins: [
          listEntry({
            id: "beta",
            name: "Beta",
            enabled: false,
            isActive: true,
            configured: false,
          }),
        ],
      },
    });
    try {
      const result = await runHandler(makeRuntime(), {
        action: "list",
        type: "plugin",
      });
      expect(String(result?.text)).toContain(
        "- Beta [beta] (disabled active, unconfigured)",
      );
    } finally {
      restore();
    }
  });

  it("degrades to a typed failure when the roster fetch throws", async () => {
    const { restore } = stubFetch([
      { reject: new Error("connection refused") },
    ]);
    try {
      const result = await runHandler(makeRuntime(), {
        action: "list",
      });

      expect(result?.success).toBe(false);
      expect(result?.data).toMatchObject({ error: "PLUGIN_LIST_FAILED" });
      expect(String(result?.text)).toContain("connection refused");
    } finally {
      restore();
    }
  });

  it("treats a malformed roster payload as an empty view, not a crash", async () => {
    const { restore } = stubFetch({ body: { plugins: "garbage" } });
    try {
      const result = await runHandler(makeRuntime(), {
        action: "list",
      });

      expect(result?.success).toBe(true);
      expect(result?.data).toMatchObject({
        count: 0,
        totalBeforeFilter: 0,
      });
      expect(String(result?.text)).toContain("No connectors match");
    } finally {
      restore();
    }
  });
});
