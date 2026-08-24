/**
 * Covers the PLUGIN action's package lifecycle and local compatibility-route
 * behavior through the real exported action. Deterministic recording managers
 * and fetch boundaries verify normalization, dispatch, ordering, redaction,
 * failure translation, and disconnect routing without live services.
 */
import type {
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EjectResult,
  InstalledPluginInfo,
  PluginInstallOptionsLike,
  PluginInstallResult,
  PluginManagerLike,
  PluginUninstallResult,
  RegistryPluginInfo,
  RegistrySearchResult,
  ReinjectResult,
  SyncResult,
} from "../services/plugin-manager-types.ts";
import { pluginAction } from "./plugin.ts";

type PluginOperation =
  | "install"
  | "uninstall"
  | "update"
  | "sync"
  | "eject"
  | "reinject";

interface CapturedRequest {
  url: string;
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
}

interface FetchStep {
  ok?: boolean;
  status?: number;
  body?: unknown;
  error?: unknown;
}

const originalFetch = globalThis.fetch;

function responseData(result: ActionResult): Record<string, unknown> {
  return (result.data ?? {}) as Record<string, unknown>;
}

function makeRuntime(service: unknown): IAgentRuntime {
  return {
    getService: (name: string) => (name === "plugin_manager" ? service : null),
  } as unknown as IAgentRuntime;
}

async function invoke(
  parameters: Record<string, unknown>,
  runtime: IAgentRuntime = makeRuntime(null),
): Promise<ActionResult> {
  const result = await pluginAction.handler(
    runtime,
    { content: { text: "" } } as never,
    undefined,
    { parameters } as HandlerOptions,
    undefined,
  );
  if (!result || typeof result !== "object") {
    throw new Error("PLUGIN handler returned no ActionResult");
  }
  return result;
}

function installFetch(steps: FetchStep[]): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  let cursor = 0;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    captured.push({
      url: String(input),
      method: init?.method,
      headers: init?.headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    const step = steps[cursor++];
    if (!step) throw new Error(`Unexpected fetch call ${cursor}`);
    if ("error" in step) throw step.error;
    return {
      ok: step.ok ?? true,
      status: step.status ?? 200,
      json: async () => step.body,
    } as Response;
  }) as typeof fetch;
  return captured;
}

class RecordingPluginManager implements PluginManagerLike {
  readonly calls = {
    install: [] as string[],
    uninstall: [] as string[],
    update: [] as Array<{
      name: string;
      options: PluginInstallOptionsLike | undefined;
    }>,
    sync: [] as string[],
    eject: [] as string[],
    reinject: [] as string[],
  };

  installResult: PluginInstallResult = {
    success: true,
    pluginName: "registry-plugin",
    version: "2.1.0",
    installPath: "/plugins/registry-plugin",
    requiresRestart: true,
  };

  uninstallResult: PluginUninstallResult = {
    success: true,
    pluginName: "registry-plugin",
    requiresRestart: false,
  };

  updateResult: PluginInstallResult = {
    success: true,
    pluginName: "registry-plugin",
    version: "2.2.0-beta.1",
    installPath: "/plugins/registry-plugin",
    requiresRestart: false,
  };

  syncResult: SyncResult = {
    success: true,
    pluginName: "registry-plugin",
    ejectedPath: "/src/registry-plugin",
    requiresRestart: false,
  };

  ejectResult: EjectResult = {
    success: true,
    pluginName: "registry-plugin",
    ejectedPath: "/src/registry-plugin",
    requiresRestart: true,
  };

  reinjectResult: ReinjectResult = {
    success: true,
    pluginName: "registry-plugin",
    removedPath: "/src/registry-plugin",
    requiresRestart: true,
  };

  async refreshRegistry(): Promise<Map<string, RegistryPluginInfo>> {
    return new Map();
  }

  async listInstalledPlugins(): Promise<InstalledPluginInfo[]> {
    return [];
  }

  async getRegistryPlugin(): Promise<RegistryPluginInfo | null> {
    return null;
  }

  async searchRegistry(): Promise<RegistrySearchResult[]> {
    return [];
  }

  async installPlugin(pluginName: string): Promise<PluginInstallResult> {
    this.calls.install.push(pluginName);
    return this.installResult;
  }

  async updatePlugin(
    pluginName: string,
    _onProgress?: undefined,
    options?: PluginInstallOptionsLike,
  ): Promise<PluginInstallResult> {
    this.calls.update.push({ name: pluginName, options });
    return this.updateResult;
  }

  async uninstallPlugin(pluginName: string): Promise<PluginUninstallResult> {
    this.calls.uninstall.push(pluginName);
    return this.uninstallResult;
  }

  async listEjectedPlugins(): Promise<InstalledPluginInfo[]> {
    return [];
  }

  async ejectPlugin(pluginName: string): Promise<EjectResult> {
    this.calls.eject.push(pluginName);
    return this.ejectResult;
  }

  async syncPlugin(pluginName: string): Promise<SyncResult> {
    this.calls.sync.push(pluginName);
    return this.syncResult;
  }

  async reinjectPlugin(pluginName: string): Promise<ReinjectResult> {
    this.calls.reinject.push(pluginName);
    return this.reinjectResult;
  }

  fail(operation: PluginOperation, error: string): void {
    switch (operation) {
      case "install":
        this.installResult = { ...this.installResult, success: false, error };
        break;
      case "uninstall":
        this.uninstallResult = {
          ...this.uninstallResult,
          success: false,
          error,
        };
        break;
      case "update":
        this.updateResult = { ...this.updateResult, success: false, error };
        break;
      case "sync":
        this.syncResult = { ...this.syncResult, success: false, error };
        break;
      case "eject":
        this.ejectResult = { ...this.ejectResult, success: false, error };
        break;
      case "reinject":
        this.reinjectResult = {
          ...this.reinjectResult,
          success: false,
          error,
        };
        break;
    }
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("pluginAction metadata and dispatch", () => {
  it("exports the owner-gated PLUGIN action and its complete operation catalog", () => {
    expect(pluginAction.name).toBe("PLUGIN");
    expect(pluginAction.roleGate).toEqual({ minRole: "OWNER" });
    expect(
      pluginAction.parameters?.find((entry) => entry.name === "action")?.schema,
    ).toEqual({
      type: "string",
      enum: [
        "install",
        "uninstall",
        "update",
        "sync",
        "eject",
        "reinject",
        "configure",
        "read_config",
        "toggle",
        "list",
        "disconnect",
      ],
    });
  });

  it("accepts local operations without a manager but gates lifecycle operations", async () => {
    const runtime = makeRuntime(null);
    await expect(
      pluginAction.validate?.(runtime, {} as never, undefined, {
        parameters: { action: "list" },
      }),
    ).resolves.toBe(true);
    await expect(
      pluginAction.validate?.(runtime, {} as never, undefined, {
        parameters: { action: "install" },
      }),
    ).resolves.toBe(false);
    await expect(
      pluginAction.validate?.(
        makeRuntime(new RecordingPluginManager()),
        {} as never,
        undefined,
        {
          parameters: { action: "install" },
        },
      ),
    ).resolves.toBe(true);
  });

  it("rejects missing, unknown, case-shifted, and whitespace-padded operations", async () => {
    for (const parameters of [
      {},
      { action: "remove" },
      { action: "INSTALL" },
      { action: " install " },
    ]) {
      const result = await invoke(parameters);
      expect(result.success).toBe(false);
      expect(responseData(result).error).toBe("PLUGIN_INVALID");
    }
  });
});

describe("pluginAction lifecycle operations", () => {
  it("requires both a manager service and a non-empty target", async () => {
    const operations: PluginOperation[] = [
      "install",
      "uninstall",
      "update",
      "sync",
      "eject",
      "reinject",
    ];
    for (const operation of operations) {
      const absent = await invoke({ action: operation, pluginId: "calendar" });
      expect(absent.success).toBe(false);
      expect(responseData(absent).error).toBe(
        `PLUGIN_${operation.toUpperCase()}_FAILED`,
      );

      const manager = new RecordingPluginManager();
      const missing = await invoke(
        { action: operation, pluginId: "   " },
        makeRuntime(manager),
      );
      expect(missing.success).toBe(false);
      expect(responseData(missing).error).toBe(
        `PLUGIN_${operation.toUpperCase()}_FAILED`,
      );
      expect(Object.values(manager.calls).flat()).toHaveLength(0);
    }
  });

  it("normalizes registry package names while preserving source-operation ids", async () => {
    vi.useFakeTimers();
    const manager = new RecordingPluginManager();
    const runtime = makeRuntime(manager);

    const install = await invoke(
      { subaction: "install", connectorId: "  discord  " },
      runtime,
    );
    const uninstall = await invoke(
      { action: "uninstall", pluginId: "@acme/custom" },
      runtime,
    );
    const update = await invoke(
      { op: "update", pluginId: "calendar", stream: "beta" },
      runtime,
    );
    await invoke({ action: "sync", pluginId: "  notes  " }, runtime);
    await invoke({ action: "eject", pluginId: "  goals  " }, runtime);
    await invoke({ action: "reinject", pluginId: "  todos  " }, runtime);

    expect(manager.calls.install).toEqual(["@elizaos/plugin-discord"]);
    expect(manager.calls.uninstall).toEqual(["@acme/custom"]);
    expect(manager.calls.update).toEqual([
      {
        name: "@elizaos/plugin-calendar",
        options: { releaseStream: "beta" },
      },
    ]);
    expect(manager.calls.sync).toEqual(["notes"]);
    expect(manager.calls.eject).toEqual(["goals"]);
    expect(manager.calls.reinject).toEqual(["todos"]);
    expect(install.text).toContain("agent will restart");
    expect(responseData(install)).toMatchObject({
      op: "install",
      pluginId: "discord",
      npmName: "@elizaos/plugin-discord",
    });
    expect(uninstall.text).not.toContain("restart");
    expect(responseData(update)).toMatchObject({
      op: "update",
      stream: "beta",
    });
    expect(vi.getTimerCount()).toBe(2);
  });

  it("maps every manager-declared failure to its operation-specific result", async () => {
    const operations: PluginOperation[] = [
      "install",
      "uninstall",
      "update",
      "sync",
      "eject",
      "reinject",
    ];
    for (const operation of operations) {
      const manager = new RecordingPluginManager();
      manager.fail(operation, "registry unavailable");
      const result = await invoke(
        { action: operation, pluginId: "calendar" },
        makeRuntime(manager),
      );
      expect(result.success).toBe(false);
      expect(result.text).toContain("registry unavailable");
      expect(responseData(result).error).toBe(
        `PLUGIN_${operation.toUpperCase()}_FAILED`,
      );
    }
  });

  it("reports an older manager without update support and translates thrown errors", async () => {
    const olderManager = {
      refreshRegistry: async () => new Map(),
      listInstalledPlugins: async () => [],
      getRegistryPlugin: async () => null,
      searchRegistry: async () => [],
      installPlugin: async () => {
        throw "registry offline";
      },
      uninstallPlugin: async () => ({
        success: true,
        pluginName: "calendar",
        requiresRestart: false,
      }),
    };
    const unsupported = await invoke(
      { action: "update", pluginId: "calendar" },
      makeRuntime(olderManager),
    );
    expect(unsupported.success).toBe(false);
    expect(unsupported.text).toBe("Plugin manager does not support updates.");

    const thrown = await invoke(
      { action: "install", pluginId: "calendar" },
      makeRuntime(olderManager),
    );
    expect(thrown.success).toBe(false);
    expect(thrown.text).toBe("Failed to install: registry offline");
    expect(responseData(thrown).error).toBe("PLUGIN_INSTALL_FAILED");
  });
});

describe("pluginAction configure and read_config", () => {
  it("normalizes scalar config values and reports a successful connection test", async () => {
    const requests = installFetch([
      { body: { success: true, requiresRestart: true } },
      { body: { success: true, durationMs: 37 } },
    ]);
    const result = await invoke({
      action: "configure",
      pluginId: "@elizaos/plugin-demo",
      config: {
        ZETA: true,
        ALPHA: 7,
        TOKEN: "secret",
        IGNORED: { nested: true },
        ALSO_IGNORED: null,
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: "PUT",
      body: { config: { ZETA: "true", ALPHA: "7", TOKEN: "secret" } },
    });
    expect(requests[0].url).toContain(
      `/api/plugins/${encodeURIComponent("@elizaos/plugin-demo")}`,
    );
    expect(requests[1]).toMatchObject({ method: "POST" });
    expect(requests[1].url).toContain("/test");
    expect(result.success).toBe(true);
    expect(result.text).toContain("config (ALPHA, TOKEN, ZETA)");
    expect(result.text).toContain("agent will restart");
    expect(result.text).toContain("Connection test passed (37ms)");
  });

  it("rejects absent or empty normalized config before making a request", async () => {
    const requests = installFetch([]);
    for (const config of [undefined, null, [], {}, { nested: {} }]) {
      const result = await invoke({
        action: "configure",
        pluginId: "demo",
        config,
      });
      expect(result.success).toBe(false);
      expect(responseData(result).error).toBe("PLUGIN_CONFIGURE_FAILED");
    }
    expect(requests).toHaveLength(0);
  });

  it("does not connection-test a rejected save", async () => {
    const requests = installFetch([
      { ok: false, status: 409, body: { error: "conflicting config" } },
    ]);
    const result = await invoke({
      action: "configure",
      pluginId: "demo",
      config: { TOKEN: "secret" },
    });
    expect(requests).toHaveLength(1);
    expect(result.success).toBe(false);
    expect(result.text).toContain("conflicting config");
  });

  it("distinguishes a failed connection test from a skipped one", async () => {
    installFetch([
      { body: { success: true } },
      { body: { success: false, error: "bad credentials" } },
    ]);
    const failed = await invoke({
      action: "configure",
      pluginId: "demo",
      config: { TOKEN: "wrong" },
    });
    expect(failed.text).toContain("Connection test failed: bad credentials");

    installFetch([
      { body: { success: true } },
      { error: new Error("socket closed") },
    ]);
    const skipped = await invoke({
      action: "configure",
      pluginId: "demo",
      config: { TOKEN: "new" },
    });
    expect(skipped.success).toBe(true);
    expect(skipped.text).toContain("Connection test skipped: socket closed");
  });

  it("prefers an exact id and redacts sensitive parameter values", async () => {
    installFetch([
      {
        body: {
          plugins: [
            {
              id: "demo-extra",
              name: "Demo Extra",
              description: "fuzzy candidate",
              enabled: false,
              configured: false,
              parameters: [],
            },
            {
              id: "demo",
              name: "Demo",
              description: "exact candidate",
              enabled: true,
              configured: true,
              version: "3.0.0",
              loadError: "restart pending",
              parameters: [
                {
                  key: "TOKEN",
                  required: true,
                  sensitive: true,
                  isSet: true,
                  currentValue: "never-return-this",
                },
                {
                  key: "REGION",
                  isSet: true,
                  currentValue: "us-east-1",
                },
              ],
            },
          ],
        },
      },
    ]);
    const result = await invoke({ action: "read_config", pluginId: "demo" });
    const plugin = responseData(result).plugin as {
      id: string;
      parameters: Array<{ key: string; currentValue: string | null }>;
    };

    expect(result.success).toBe(true);
    expect(result.text).toContain("Plugin: Demo (demo)");
    expect(result.text).toContain("TOKEN [required] [sensitive] = ***");
    expect(result.text).not.toContain("never-return-this");
    expect(plugin.id).toBe("demo");
    expect(plugin.parameters).toEqual([
      {
        key: "TOKEN",
        required: true,
        sensitive: true,
        isSet: true,
        currentValue: null,
      },
      {
        key: "REGION",
        required: false,
        sensitive: false,
        isSet: true,
        currentValue: "us-east-1",
      },
    ]);
  });

  it("supports case-insensitive fuzzy lookup and the configKeys fallback", async () => {
    installFetch([
      {
        body: {
          plugins: [
            {
              id: "@elizaos/plugin-calendar",
              name: "Calendar Connector",
              description: "calendar",
              enabled: false,
              configured: false,
              parameters: [],
              configKeys: ["CLIENT_ID", "CLIENT_SECRET"],
            },
          ],
        },
      },
    ]);
    const result = await invoke({
      action: "read_config",
      connectorId: "CALENDAR CONNECT",
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("Config keys: CLIENT_ID, CLIENT_SECRET");
  });

  it("reports HTTP, not-found, and thrown read failures distinctly", async () => {
    installFetch([{ ok: false, status: 503 }]);
    const http = await invoke({ action: "read_config", pluginId: "demo" });
    expect(responseData(http).error).toBe("PLUGIN_READ_CONFIG_FAILED");
    expect(http.text).toContain("HTTP 503");

    installFetch([{ body: { plugins: [] } }]);
    const missing = await invoke({ action: "read_config", pluginId: "demo" });
    expect(responseData(missing).error).toBe("PLUGIN_READ_CONFIG_NOT_FOUND");

    installFetch([{ error: "connection refused" }]);
    const thrown = await invoke({ action: "read_config", pluginId: "demo" });
    expect(responseData(thrown).error).toBe("PLUGIN_READ_CONFIG_FAILED");
    expect(thrown.text).toBe("Failed to read_config: connection refused");
  });
});

describe("pluginAction list", () => {
  it("returns every plugin in API order without imposing a capacity limit", async () => {
    const plugins = Array.from({ length: 137 }, (_, index) => ({
      id: `plugin-${index.toString().padStart(3, "0")}`,
      name: `Plugin ${index}`,
      description: "generated fixture",
      enabled: index % 2 === 0,
      configured: true,
      parameters: [],
      category: index % 3 === 0 ? "connector" : "utility",
    }));
    installFetch([{ body: { plugins } }]);
    const result = await invoke({ action: "list", type: "plugin" });
    const entries = responseData(result).entries as Array<{ id: string }>;
    expect(result.success).toBe(true);
    expect(entries).toHaveLength(137);
    expect(entries[0].id).toBe("plugin-000");
    expect(entries.at(-1)?.id).toBe("plugin-136");
    expect(result.text?.split("\n")).toHaveLength(138);
  });

  it("composes flat search, configured, and status filters", async () => {
    installFetch([
      {
        body: {
          plugins: [
            {
              id: "discord",
              name: "Discord",
              description: "Team chat",
              enabled: true,
              configured: true,
              isActive: true,
              category: "connector",
              parameters: [],
            },
            {
              id: "discord-staging",
              name: "Discord Staging",
              description: "Team chat",
              enabled: true,
              configured: false,
              isActive: true,
              category: "connector",
              parameters: [],
            },
            {
              id: "slack",
              name: "Slack",
              description: "Team chat",
              enabled: true,
              configured: true,
              isActive: true,
              category: "connector",
              parameters: [],
            },
          ],
        },
      },
    ]);
    const result = await invoke({
      action: "list",
      type: "connector",
      search: "DISCORD",
      configured: true,
      status: "active",
    });
    const entries = responseData(result).entries as Array<{ id: string }>;
    expect(entries.map((entry) => entry.id)).toEqual(["discord"]);
    expect(result.text).toContain(
      'narrowed by status=active, configured=true, search="DISCORD"',
    );
  });

  it("describes an unfiltered empty list and singular pre-filter scope", async () => {
    installFetch([{ body: { plugins: [] } }]);
    const empty = await invoke({ action: "list", type: "connector" });
    expect(empty.success).toBe(true);
    expect(empty.text).toContain(
      "0 connectors exist but none are listed under this view",
    );

    installFetch([
      {
        body: {
          plugins: [
            {
              id: "discord",
              name: "Discord",
              description: "Team chat",
              enabled: true,
              configured: true,
              isActive: true,
              category: "connector",
              parameters: [],
            },
          ],
        },
      },
    ]);
    const single = await invoke({
      action: "list",
      type: "connector",
      status: "disabled",
    });
    expect(single.text).toContain("1 connector exist before filtering");
  });

  it("translates non-OK and malformed list responses", async () => {
    installFetch([{ ok: false, status: 502 }]);
    const failed = await invoke({ action: "list", type: "plugin" });
    expect(failed.success).toBe(false);
    expect(responseData(failed).error).toBe("PLUGIN_LIST_FAILED");
    expect(failed.text).toContain("/api/plugins returned 502");

    installFetch([{ body: { plugins: "not-an-array" } }]);
    const malformed = await invoke({ action: "list", type: "plugin" });
    expect(malformed.success).toBe(true);
    expect(responseData(malformed).entries).toEqual([]);
  });
});

describe("pluginAction disconnect", () => {
  it("routes known connectors to their dedicated case-insensitive endpoints", async () => {
    const requests = installFetch([
      { body: { success: true, message: "Telegram signed out." } },
      { body: { ok: true } },
    ]);
    const telegram = await invoke({
      action: "disconnect",
      connectorId: "TELEGRAM",
    });
    const discord = await invoke({
      action: "disconnect",
      pluginId: "discord-local",
    });
    expect(requests.map((request) => request.url)).toEqual([
      expect.stringMatching(/\/api\/setup\/telegram-account\/cancel$/),
      expect.stringMatching(/\/api\/discord-local\/disconnect$/),
    ]);
    expect(requests.every((request) => request.method === "POST")).toBe(true);
    expect(telegram.text).toBe("Telegram signed out.");
    expect(responseData(discord)).toMatchObject({
      endpoint: "/api/discord-local/disconnect",
      connectorId: "discord-local",
    });
  });

  it("falls back to disabling an unknown connector and reports restart needs", async () => {
    const requests = installFetch([
      { body: { success: true, requiresRestart: true } },
    ]);
    const result = await invoke({
      action: "disconnect",
      connectorId: "@acme/custom connector",
    });
    expect(requests[0]).toMatchObject({
      method: "PUT",
      body: { enabled: false },
    });
    expect(requests[0].url).toContain(
      encodeURIComponent("@acme/custom connector"),
    );
    expect(result.text).toContain("by disabling the connector");
    expect(result.text).toContain("restart to drop the session");
    expect(responseData(result).fallback).toBe("plugin-disable");
  });

  it("rejects a missing target and translates dedicated and fallback failures", async () => {
    const missing = await invoke({ action: "disconnect", connectorId: "  " });
    expect(responseData(missing).error).toBe("PLUGIN_DISCONNECT_FAILED");

    installFetch([
      { ok: false, status: 401, body: { message: "not authenticated" } },
    ]);
    const dedicated = await invoke({
      action: "disconnect",
      connectorId: "whatsapp",
    });
    expect(dedicated.text).toContain("not authenticated");

    installFetch([{ ok: false, status: 500, body: {} }]);
    const fallback = await invoke({
      action: "disconnect",
      connectorId: "custom",
    });
    expect(fallback.text).toContain("Disconnect failed (500)");
    expect(responseData(fallback).error).toBe("PLUGIN_DISCONNECT_FAILED");
  });
});
