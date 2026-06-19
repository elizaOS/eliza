import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureRouteAuthorized: vi.fn(),
  loadElizaConfig: vi.fn(),
  loadRegistry: vi.fn(),
  readCompatJsonBody: vi.fn(),
  saveElizaConfig: vi.fn(),
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
  sendJson: vi.fn(),
  sendJsonError: mocks.sendJsonError,
}));

vi.mock("@elizaos/app-core/registry", () => ({
  loadRegistry: mocks.loadRegistry,
}));

vi.mock("@elizaos/app-core/services/vault-mirror", () => ({
  _resetSharedVaultForTesting: vi.fn(),
  mirrorPluginSensitiveToVault: vi.fn(() =>
    Promise.resolve({ failures: [] }),
  ),
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
  STREAMING_PLUGINS: {},
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

describe("persistCompatPluginMutation", () => {
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
    mocks.saveElizaConfig.mockImplementation((config) => {
      savedConfig = clone(config);
    });
    mocks.ensureRouteAuthorized.mockResolvedValue(true);
    mocks.readCompatJsonBody.mockResolvedValue({});
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
});
