/** Exercises malformed plugin identifiers before manager or runtime mutation. */
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
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
    npmName: "@elizaos/plugin-discord",
  };
}

function makeContext(
  overrides: Partial<Pick<PluginRouteContext, "method" | "pathname">> = {},
): PluginRouteContext {
  return {
    req: {} as never,
    res: {} as never,
    method: overrides.method ?? "GET",
    pathname: overrides.pathname ?? "/api/plugins",
    url: new URL(`http://localhost${overrides.pathname ?? "/api/plugins"}`),
    state: {
      runtime: null,
      config: { env: {}, plugins: { entries: {} } } as never,
      plugins: [makePlugin() as never],
      broadcastWs: null,
    },
    json: vi.fn(),
    error: vi.fn(),
    readJsonBody: vi.fn(() => Promise.resolve({})),
    scheduleRuntimeRestart: vi.fn(),
    restartRuntime: vi.fn(),
    isBlockedEnvKey: () => false,
    discoverInstalledPlugins: vi.fn(() => []),
    maskValue: vi.fn((value: string) => `***${value.length}`),
    aggregateSecrets: vi.fn(() => []),
    readProviderCache: vi.fn(() => null),
    paramKeyToCategory: vi.fn(() => "text"),
    buildPluginEvmDiagnosticEntry: vi.fn(() => makePlugin()),
    EVM_PLUGIN_PACKAGE: "@elizaos/plugin-evm",
    applyWhatsAppQrOverride: vi.fn(),
    applySignalQrOverride: vi.fn(),
    resolvePluginConfigMutationRejections: vi.fn(() => []),
    requirePluginManager: vi.fn(),
    requireCoreManager: vi.fn(),
  } as never;
}

describe("POST /api/plugins/:id encoding", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    mocks.loadElizaConfig.mockImplementation(() => ({
      env: {},
      plugins: { entries: {} },
    }));
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

  it("GET /api/plugins list is untouched", async () => {
    const ctx = makeContext({ method: "GET", pathname: "/api/plugins" });
    const handled = await handlePluginRoutes(ctx);
    expect(handled).toBe(true);
    expect(ctx.error).not.toHaveBeenCalled();
    expect(ctx.json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({ plugins: expect.any(Array) }),
    );
  });

  it("canonical eject still reaches requirePluginManager", async () => {
    const ctx = makeContext({
      method: "POST",
      pathname: "/api/plugins/discord/eject",
    });
    await handlePluginRoutes(ctx);
    expect(ctx.requirePluginManager).toHaveBeenCalled();
    expect(ctx.error).not.toHaveBeenCalledWith(
      ctx.res,
      "Invalid plugin id: malformed URL encoding",
      400,
    );
  });

  it("canonical percent-encoded hyphen still decodes before eject", async () => {
    const ctx = makeContext({
      method: "POST",
      pathname: "/api/plugins/disc%2Dord/eject",
    });
    await handlePluginRoutes(ctx);
    expect(ctx.requirePluginManager).toHaveBeenCalled();
  });

  it.each([
    ["/api/plugins/%/test", "test"],
    ["/api/plugins/%2/eject", "eject"],
    ["/api/plugins/%ZZ/sync", "sync"],
    ["/api/plugins/%E0%A4/reinject", "reinject"],
  ])("rejects malformed %s with 400", async (pathname) => {
    const ctx = makeContext({ method: "POST", pathname });
    const handled = await handlePluginRoutes(ctx);
    expect(handled).toBe(true);
    expect(ctx.error).toHaveBeenCalledWith(
      ctx.res,
      "Invalid plugin id: malformed URL encoding",
      400,
    );
    expect(ctx.requirePluginManager).not.toHaveBeenCalled();
  });
});
