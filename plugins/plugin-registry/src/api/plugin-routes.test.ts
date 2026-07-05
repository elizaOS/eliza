import { logger } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyPluginRuntimeMutation: vi.fn(),
  loadElizaConfig: vi.fn(),
  saveElizaConfig: vi.fn(),
  validatePluginConfig: vi.fn(),
}));

vi.mock("@elizaos/agent", () => ({
  applyAdvancedCapabilitiesConfig: vi.fn(),
  applyPluginRuntimeMutation: mocks.applyPluginRuntimeMutation,
  CORE_PLUGINS: [],
  getPluginWidgets: vi.fn(() => []),
  isAdvancedCapabilityPluginId: vi.fn(() => false),
  loadElizaConfig: mocks.loadElizaConfig,
  OPTIONAL_CORE_PLUGINS: [],
  resolveAdvancedCapabilitiesEnabled: vi.fn(() => false),
  resolveDefaultAgentWorkspaceDir: vi.fn(() => "/tmp"),
  saveElizaConfig: mocks.saveElizaConfig,
  validatePluginConfig: mocks.validatePluginConfig,
}));

vi.mock("@elizaos/core", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@elizaos/shared", () => {
  const schema = {
    safeParse: (value: unknown) => ({ success: true, data: value }),
  };

  return {
    asRecord: (value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null,
    isElizaSettingsDebugEnabled: vi.fn(() => false),
    PostPluginCoreToggleRequestSchema: schema,
    PostPluginInstallRequestSchema: schema,
    PostPluginUninstallRequestSchema: schema,
    PostPluginUpdateRequestSchema: schema,
    PutPluginRequestSchema: schema,
    PutSecretsRequestSchema: schema,
    sanitizeForSettingsDebug: (value: unknown) => value,
    settingsDebugCloudSummary: (value: unknown) => value,
  };
});

import {
  handlePluginRoutes,
  type PluginRouteContext,
} from "./plugin-routes.js";

const originalEnv = { ...process.env };

function makePlugin() {
  return {
    id: "discord",
    name: "Discord",
    description: "",
    tags: [],
    enabled: false,
    configured: false,
    envKey: "DISCORD_API_TOKEN",
    category: "connector",
    source: "bundled",
    configKeys: ["DISCORD_API_TOKEN"],
    parameters: [
      {
        key: "DISCORD_API_TOKEN",
        required: false,
        sensitive: true,
        type: "string",
      },
    ],
    validationErrors: [],
    validationWarnings: [],
    npmName: "@elizaos/plugin-discord",
  };
}

function makeContext(
  body: Record<string, unknown>,
  config: Record<string, unknown>,
  overrides: Partial<
    Pick<PluginRouteContext, "method" | "pathname" | "url">
  > = {},
): PluginRouteContext {
  return {
    req: {} as never,
    res: {} as never,
    method: overrides.method ?? "PUT",
    pathname: overrides.pathname ?? "/api/plugins/discord",
    url: overrides.url ?? new URL("http://localhost/api/plugins/discord"),
    state: {
      runtime: null,
      config: config as never,
      plugins: [makePlugin() as never],
      broadcastWs: null,
    },
    json: vi.fn(),
    error: vi.fn(),
    readJsonBody: vi.fn(() => Promise.resolve(body)),
    scheduleRuntimeRestart: vi.fn(),
    restartRuntime: vi.fn(),
    BLOCKED_ENV_KEYS: new Set(),
    discoverInstalledPlugins: vi.fn(() => []),
    maskValue: vi.fn((value: string) => `***${value.length}`),
    aggregateSecrets: vi.fn(() => []),
    readProviderCache: vi.fn(() => null),
    paramKeyToCategory: vi.fn(() => "text"),
    buildPluginEvmDiagnosticEntry: vi.fn(),
    EVM_PLUGIN_PACKAGE: "@elizaos/plugin-evm",
    applyWhatsAppQrOverride: vi.fn(),
    applySignalQrOverride: vi.fn(),
    resolvePluginConfigMutationRejections: vi.fn(() => []),
    requirePluginManager: vi.fn(),
    requireCoreManager: vi.fn(),
  } as never;
}

describe("handlePluginRoutes config persistence", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DISCORD_API_TOKEN;
    mocks.loadElizaConfig.mockImplementation(() => ({
      env: {},
      plugins: { entries: {} },
    }));
    mocks.saveElizaConfig.mockClear();
    mocks.validatePluginConfig.mockReturnValue({
      valid: true,
      errors: [],
      warnings: [],
    });
    mocks.applyPluginRuntimeMutation.mockResolvedValue({
      mode: "none",
      requiresRestart: false,
      restartedRuntime: false,
      loadedPackages: [],
      unloadedPackages: [],
      reloadedPackages: [],
    });
  });

  it("persists submitted config to env and plugins.entries", async () => {
    const config = { env: {}, plugins: { entries: {} } };
    const ctx = makeContext(
      { config: { DISCORD_API_TOKEN: "abc123" } },
      config,
    );

    const handled = await handlePluginRoutes(ctx);

    expect(handled).toBe(true);
    expect(config).toEqual({
      env: { DISCORD_API_TOKEN: "abc123" },
      plugins: {
        entries: {
          discord: {
            config: {
              DISCORD_API_TOKEN: "abc123",
            },
          },
        },
      },
    });
    expect(process.env.DISCORD_API_TOKEN).toBe("abc123");
    expect(mocks.saveElizaConfig).toHaveBeenCalledWith(config);
    expect(ctx.json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({ ok: true }),
    );
  });

  it("removes blank optional config values from persisted and process env", async () => {
    process.env.DISCORD_API_TOKEN = "old";
    const config = {
      env: { DISCORD_API_TOKEN: "old" },
      plugins: {
        entries: {
          discord: {
            enabled: true,
            config: { DISCORD_API_TOKEN: "old" },
          },
        },
      },
    };
    const ctx = makeContext({ config: { DISCORD_API_TOKEN: " " } }, config);

    await handlePluginRoutes(ctx);

    expect(config).toEqual({
      env: {},
      plugins: {
        entries: {
          discord: {
            enabled: true,
            config: {},
          },
        },
      },
    });
    expect(process.env.DISCORD_API_TOKEN).toBeUndefined();
  });

  it.each([
    "../../evil",
    "@scope/../evil",
    "plugin name",
    "",
    "   ",
  ])("rejects hostile install package name %j before installer access", async (name) => {
    const config = { env: {}, plugins: { entries: {} } };
    const requirePluginManager = vi.fn();
    const ctx = {
      ...makeContext({ name }, config, {
        method: "POST",
        pathname: "/api/plugins/install",
        url: new URL("http://localhost/api/plugins/install"),
      }),
      requirePluginManager,
    } as PluginRouteContext;

    const handled = await handlePluginRoutes(ctx);

    expect(handled).toBe(true);
    expect(requirePluginManager).not.toHaveBeenCalled();
    expect(ctx.error).toHaveBeenCalledWith(ctx.res, expect.any(String), 400);
  });

  it("returns /api/plugins with best-effort metadata when registry refresh hangs", async () => {
    vi.useFakeTimers();
    try {
      const config = { env: {}, plugins: { entries: {} } };
      const ctx = makeContext({}, config, {
        method: "GET",
        pathname: "/api/plugins",
        url: new URL("http://localhost/api/plugins"),
      });
      const never = new Promise<Map<string, never>>(() => {});
      const listInstalledPlugins = vi.fn().mockResolvedValue([
        {
          name: "@elizaos/plugin-discord",
          version: "1.2.3",
          releaseStream: "latest",
          requestedVersion: "1.2.3",
          latestVersion: "1.2.3",
          betaVersion: null,
        },
      ]);
      const refreshRegistry = vi.fn(() => never);
      ctx.requirePluginManager = vi.fn(() => ({
        listInstalledPlugins,
        refreshRegistry,
      })) as never;
      ctx.buildPluginEvmDiagnosticEntry = vi.fn(() => ({
        ...makePlugin(),
        id: "evm",
        name: "EVM",
        npmName: "@elizaos/plugin-evm",
      })) as never;

      const handled = handlePluginRoutes(ctx);

      await vi.advanceTimersByTimeAsync(2500);

      await expect(handled).resolves.toBe(true);
      expect(ctx.json).toHaveBeenCalledWith(ctx.res, {
        plugins: expect.arrayContaining([
          expect.objectContaining({
            id: "discord",
            version: "1.2.3",
            latestVersion: "1.2.3",
          }),
        ]),
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("registry plugin metadata"),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
