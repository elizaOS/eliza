import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureRouteAuthorized: vi.fn(),
  loadElizaConfig: vi.fn(),
  loadRegistry: vi.fn(),
  readCompatJsonBody: vi.fn(),
  saveElizaConfig: vi.fn(),
  sendJson: vi.fn(),
  sendJsonError: vi.fn(),
}));

vi.mock("@elizaos/agent", () => ({
  applyPluginRuntimeMutation: vi.fn(),
  CONNECTOR_ENV_MAP: {
    discord: {
      token: "DISCORD_API_TOKEN",
    },
  },
  discoverPluginsFromManifest: vi.fn(() => []),
  findPrimaryEnvKey: vi.fn((keys: string[]) => keys[0] ?? null),
  isAdvancedCapabilityPluginId: vi.fn(() => false),
  isVaultRef: vi.fn(() => false),
  loadElizaConfig: mocks.loadElizaConfig,
  parseVaultRef: vi.fn(),
  readBundledPluginPackageMetadata: vi.fn(),
  resolveAdvancedCapabilitiesEnabled: vi.fn(() => false),
  saveElizaConfig: mocks.saveElizaConfig,
}));

vi.mock("@elizaos/app-core/api/auth", () => ({
  ensureCompatSensitiveRouteAuthorized: vi.fn(),
  ensureRouteAuthorized: mocks.ensureRouteAuthorized,
}));

vi.mock("@elizaos/app-core/api/compat-route-shared", () => ({
  readCompatJsonBody: mocks.readCompatJsonBody,
  scheduleCompatRuntimeRestart: vi.fn(),
}));

vi.mock("@elizaos/app-core/api/response", () => ({
  sendJson: mocks.sendJson,
  sendJsonError: mocks.sendJsonError,
}));

vi.mock("@elizaos/registry/first-party", () => ({
  loadRegistry: mocks.loadRegistry,
}));

vi.mock("@elizaos/app-core/services/vault-mirror", () => ({
  _resetSharedVaultForTesting: vi.fn(),
  mirrorPluginSensitiveToVault: vi.fn(() => Promise.resolve({ failures: [] })),
  sharedVault: {},
}));

vi.mock("@elizaos/core", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@elizaos/shared", () => ({
  asRecord: (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null,
  CONNECTOR_PLUGINS: {
    discord: "@elizaos/plugin-discord",
  },
}));

vi.mock("@elizaos/vault", () => ({
  VaultMissError: class VaultMissError extends Error {},
}));

import {
  buildPluginListResponse,
  handlePluginsCompatRoutes,
  persistCompatPluginMutation,
} from "./app-plugins-routes.js";

const originalEnv = { ...process.env };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function makePlugin(overrides: Record<string, unknown> = {}) {
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
    isActive: false,
    ...overrides,
  };
}

describe("app plugin compatibility routes", () => {
  let currentConfig: Record<string, unknown>;
  let savedConfig: Record<string, unknown> | undefined;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DISCORD_API_TOKEN;
    currentConfig = {
      env: {},
      plugins: {
        entries: {},
      },
    };
    savedConfig = undefined;
    mocks.loadElizaConfig.mockImplementation(() => currentConfig);
    mocks.loadRegistry.mockReturnValue({ all: [], byId: new Map() });
    mocks.loadRegistry.mockClear();
    mocks.saveElizaConfig.mockImplementation((config) => {
      savedConfig = clone(config);
    });
    mocks.ensureRouteAuthorized.mockResolvedValue(true);
    mocks.readCompatJsonBody.mockResolvedValue({});
    mocks.sendJson.mockClear();
    mocks.sendJsonError.mockClear();
  });

  it("rejects undeclared config keys without saving", () => {
    const result = persistCompatPluginMutation(
      "discord",
      { config: { DISCORD_API_TOKEN: "token", OTHER_KEY: "bad" } },
      makePlugin(),
    );

    expect(result.status).toBe(422);
    expect(result.payload.validationErrors).toEqual([
      expect.objectContaining({ field: "OTHER_KEY" }),
    ]);
    expect(mocks.saveElizaConfig).not.toHaveBeenCalled();
  });

  it("writes valid config values to env, plugin entry config, and process.env", () => {
    const result = persistCompatPluginMutation(
      "discord",
      { config: { DISCORD_API_TOKEN: "abc123" } },
      makePlugin(),
    );

    expect(result.status).toBe(200);
    expect(savedConfig?.env).toEqual({ DISCORD_API_TOKEN: "abc123" });
    expect(savedConfig?.plugins).toEqual({
      entries: {
        discord: {
          config: {
            DISCORD_API_TOKEN: "abc123",
          },
        },
      },
    });
    expect(process.env.DISCORD_API_TOKEN).toBe("abc123");
  });

  it("removes optional blank values from persisted and process env", () => {
    process.env.DISCORD_API_TOKEN = "old";
    currentConfig = {
      env: { DISCORD_API_TOKEN: "old" },
      plugins: {
        entries: {
          discord: {
            config: {
              DISCORD_API_TOKEN: "old",
            },
          },
        },
      },
    };

    const result = persistCompatPluginMutation(
      "discord",
      { config: { DISCORD_API_TOKEN: " " } },
      makePlugin(),
    );

    expect(result.status).toBe(200);
    expect(savedConfig?.env).toEqual({});
    expect(savedConfig?.plugins).toEqual({
      entries: {
        discord: {
          config: {},
        },
      },
    });
    expect(process.env.DISCORD_API_TOKEN).toBeUndefined();
  });

  it("mirrors connector enabled state to the compat connector section", () => {
    const result = persistCompatPluginMutation(
      "discord",
      { enabled: true },
      makePlugin(),
    );

    expect(result.status).toBe(200);
    expect(savedConfig?.plugins).toEqual({
      entries: {
        discord: {
          enabled: true,
        },
      },
      allow: ["@elizaos/plugin-discord"],
    });
    expect(savedConfig?.connectors).toEqual({
      discord: {
        enabled: true,
      },
    });
  });

  it("does not mark a plugin active from unrelated loaded-name substrings", () => {
    const discordEntry = {
      id: "discord",
      name: "Discord",
      npmName: "@elizaos/plugin-discord",
      description: "",
      tags: [],
      kind: "connector",
      subtype: "chat",
      config: {},
      render: {},
      resources: {},
      version: "1.0.0",
    };
    mocks.loadRegistry.mockReturnValue({
      all: [discordEntry],
      byId: new Map([["discord", discordEntry]]),
    });

    const response = buildPluginListResponse({
      plugins: [{ name: "my-discord-helper" }],
    } as never);

    expect(response.plugins.find((plugin) => plugin.id === "discord")).toEqual(
      expect.objectContaining({ isActive: false }),
    );
  });

  it("builds the plugin list once for GET /api/plugins", async () => {
    const discordEntry = {
      id: "discord",
      name: "Discord",
      npmName: "@elizaos/plugin-discord",
      description: "",
      tags: [],
      kind: "connector",
      subtype: "chat",
      config: {},
      render: {},
      resources: {},
      version: "1.0.0",
    };
    mocks.loadRegistry.mockReturnValue({
      all: [discordEntry],
      byId: new Map([["discord", discordEntry]]),
    });

    const handled = await handlePluginsCompatRoutes(
      {
        method: "GET",
        url: "/api/plugins",
      } as never,
      {} as never,
      { current: null } as never,
    );

    expect(handled).toBe(true);
    expect(mocks.loadRegistry).toHaveBeenCalledTimes(1);
    expect(mocks.sendJson).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        plugins: expect.arrayContaining([
          expect.objectContaining({ id: "discord" }),
        ]),
      }),
    );
  });

  it("returns 400 instead of throwing on malformed encoded plugin path", async () => {
    const saveCallCount = mocks.saveElizaConfig.mock.calls.length;

    const handled = await handlePluginsCompatRoutes(
      {
        method: "PUT",
        url: "/api/plugins/%E0%A4%A",
      } as never,
      {} as never,
      { current: null } as never,
    );

    expect(handled).toBe(true);
    expect(mocks.sendJsonError).toHaveBeenCalledWith(
      expect.anything(),
      400,
      "Invalid plugin path",
    );
    expect(mocks.saveElizaConfig).toHaveBeenCalledTimes(saveCallCount);
  });

  describe("persistCompatPluginMutation plugins.allow synchronization", () => {
    it("adds npm name to plugins.allow when enabling a plugin", () => {
      const result = persistCompatPluginMutation(
        "personal-assistant",
        { enabled: true },
        makePlugin({
          id: "personal-assistant",
          npmName: "@elizaos/plugin-personal-assistant",
          category: "feature",
        }) as never,
      );

      expect(result.status).toBe(200);
      expect(
        (savedConfig as Record<string, unknown>)?.plugins as Record<
          string,
          unknown
        >,
      ).toHaveProperty("allow", [
        "@elizaos/plugin-personal-assistant",
      ]);
    });

    it("removes all aliases from plugins.allow when disabling", () => {
      currentConfig = {
        env: {},
        plugins: {
          entries: {
            "personal-assistant": { enabled: true },
          },
          allow: [
            "@elizaos/plugin-personal-assistant",
            "personal-assistant",
            "@elizaos/plugin-discord",
          ],
        },
      };

      const result = persistCompatPluginMutation(
        "personal-assistant",
        { enabled: false },
        makePlugin({
          id: "personal-assistant",
          npmName: "@elizaos/plugin-personal-assistant",
          category: "feature",
        }) as never,
      );

      expect(result.status).toBe(200);
      // Only the unrelated discord entry remains.
      expect(
        (savedConfig as Record<string, unknown>)?.plugins as Record<
          string,
          unknown
        >,
      ).toHaveProperty("allow", ["@elizaos/plugin-discord"]);
    });

    it("initialises plugins.allow as an array when absent", () => {
      const result = persistCompatPluginMutation(
        "discord",
        { enabled: true },
        makePlugin() as never,
      );

      expect(result.status).toBe(200);
      expect(
        (savedConfig as Record<string, unknown>)?.plugins as Record<
          string,
          unknown
        >,
      ).toHaveProperty("allow", ["@elizaos/plugin-discord"]);
    });

    it("does not duplicate entries on repeated enable", () => {
      currentConfig = {
        env: {},
        plugins: {
          entries: {
            discord: { enabled: true },
          },
          allow: ["@elizaos/plugin-discord"],
        },
      };

      const result = persistCompatPluginMutation(
        "discord",
        { enabled: true },
        makePlugin() as never,
      );

      expect(result.status).toBe(200);
      expect(
        (savedConfig as Record<string, unknown>)?.plugins as Record<
          string,
          unknown
        >,
      ).toHaveProperty("allow", ["@elizaos/plugin-discord"]);
    });

    it("preserves unrelated allowlist entries on disable", () => {
      currentConfig = {
        env: {},
        plugins: {
          entries: {
            discord: { enabled: false },
          },
          allow: [
            "@elizaos/plugin-discord",
            "@elizaos/plugin-telegram",
            "@elizaos/plugin-browser",
          ],
        },
      };

      const result = persistCompatPluginMutation(
        "discord",
        { enabled: false },
        makePlugin() as never,
      );

      expect(result.status).toBe(200);
      expect(
        (savedConfig as Record<string, unknown>)?.plugins as Record<
          string,
          unknown
        >,
      ).toHaveProperty("allow", [
        "@elizaos/plugin-telegram",
        "@elizaos/plugin-browser",
      ]);
    });

    it("removes app- prefixed short aliases from @elizaos/app-* packages", () => {
      currentConfig = {
        env: {},
        plugins: {
          entries: {
            "database-viewer": { enabled: true },
          },
          allow: [
            "@elizaos/app-database-viewer",
            "app-database-viewer",
            "@elizaos/plugin-discord",
          ],
        },
      };

      const result = persistCompatPluginMutation(
        "database-viewer",
        { enabled: false },
        makePlugin({
          id: "database-viewer",
          npmName: "@elizaos/app-database-viewer",
          category: "app",
        }) as never,
      );

      expect(result.status).toBe(200);
      // The app- prefixed short alias must also be removed.
      expect(
        (savedConfig as Record<string, unknown>)?.plugins as Record<
          string,
          unknown
        >,
      ).toHaveProperty("allow", ["@elizaos/plugin-discord"]);
    });
  });
});
