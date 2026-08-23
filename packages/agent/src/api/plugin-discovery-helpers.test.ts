/**
 * Deterministic unit coverage for plugin discovery metadata, configuration,
 * secret aggregation, and categorization helpers using their real inputs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_EVENT_ALLOWED_STREAMS,
  aggregateSecrets,
  buildParamDefs,
  CONFIG_WRITE_ALLOWED_TOP_KEYS,
  categorizePlugin,
  connectorMetadataTags,
  deriveElizaRepositoryUrl,
  findPrimaryEnvKey,
  formatPluginName,
  inferDescription,
  inferSecretCategory,
  maskValue,
  mergePluginMetadataTags,
  normalizePluginMetadataTag,
  normalizePluginMetadataTags,
  normalizeRepositoryUrl,
  type PluginEntry,
  type PluginParamDef,
  pluginIdTags,
  prefixLabel,
  readBundledPluginPackageMetadata,
  resolvePluginDescription,
  resolvePluginSetupGuideUrl,
  resolvePluginTags,
} from "./plugin-discovery-helpers";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function parameter(
  key: string,
  overrides: Partial<PluginParamDef> = {},
): PluginParamDef {
  return {
    key,
    type: "string",
    description: "",
    required: false,
    sensitive: true,
    currentValue: null,
    isSet: false,
    ...overrides,
  };
}

function plugin(
  id: string,
  enabled: boolean,
  parameters: PluginParamDef[],
): PluginEntry {
  return {
    id,
    name: formatPluginName(id),
    description: "test plugin",
    tags: [],
    enabled,
    configured: true,
    envKey: null,
    category: "feature",
    source: "bundled",
    configKeys: parameters.map((entry) => entry.key),
    parameters,
    validationErrors: [],
    validationWarnings: [],
  };
}

describe("plugin configuration helpers", () => {
  it("selects the first credential-like key and returns null when none match", () => {
    expect(findPrimaryEnvKey(["HOST", "SECOND_TOKEN", "FIRST_API_KEY"])).toBe(
      "SECOND_TOKEN",
    );
    expect(findPrimaryEnvKey(["HOST", "PORT"])).toBeNull();
    expect(findPrimaryEnvKey([])).toBeNull();
  });

  it("masks short, long, and non-BMP secret values without splitting Unicode", () => {
    expect(maskValue("12345678")).toBe("****");
    expect(maskValue("abcdefghijklmno")).toBe("abcd...lmno");
    expect(maskValue("abcd1234😀xyz")).toBe("abcd...xyz");
  });

  it("builds parameter definitions from environment state and metadata", () => {
    process.env.OPENAI_API_KEY = "  secret-value  ";
    process.env.PUBLIC_HOST = "localhost";

    expect(
      buildParamDefs({
        OPENAI_API_KEY: {
          required: true,
          options: ["one", "two"],
          default: "fallback",
        },
        PUBLIC_HOST: {
          type: "url",
          optional: false,
          sensitive: false,
          description: "Public endpoint",
        },
        EMPTY_TOKEN: { required: false },
      }),
    ).toEqual([
      {
        key: "OPENAI_API_KEY",
        type: "string",
        description: "API key for Openai",
        required: true,
        sensitive: true,
        default: "fallback",
        options: ["one", "two"],
        currentValue: "  se...ue  ",
        isSet: true,
      },
      {
        key: "PUBLIC_HOST",
        type: "url",
        description: "Public endpoint",
        required: true,
        sensitive: false,
        default: undefined,
        options: undefined,
        currentValue: "localhost",
        isSet: true,
      },
      {
        key: "EMPTY_TOKEN",
        type: "string",
        description: "Authentication token for Empty",
        required: false,
        sensitive: true,
        default: undefined,
        options: undefined,
        currentValue: null,
        isSet: false,
      },
    ]);
  });

  it.each([
    ["SERVICE_API_KEY", "API key for Service"],
    ["CHAT_BOT_TOKEN", "Bot token for Chat"],
    ["AUTH_TOKEN", "Authentication token for Auth"],
    ["CLIENT_SECRET", "Secret for Client"],
    ["EVM_PRIVATE_KEY", "Private key for Evm"],
    ["DB_PASSWORD", "Password for Db"],
    ["CHAIN_RPC_URL", "RPC endpoint URL for Chain"],
    ["SERVICE_BASE_URL", "Base URL for Service"],
    ["WEBHOOK_URL", "URL for Webhook"],
    ["API_ENDPOINT", "Endpoint for Api"],
    ["DB_HOST", "Host address for Db"],
    ["HTTP_PORT", "Port number for Http"],
    ["CHAT_MODEL", "Model identifier for Chat"],
    ["TTS_VOICE_NAME", "Voice setting for Tts Voice Name"],
    ["CACHE_PATH", "Directory path for Cache Path"],
    ["FEATURE_ENABLED", "Enable/disable Feature"],
    ["ENABLE_SEARCH", "Enable/disable Enable Search"],
    ["JOB_DRY_RUN_MODE", "Dry-run mode (no real actions)"],
    ["POLL_INTERVAL_MINUTES", "Check interval for Poll Interval Minutes"],
    ["REQUEST_TIMEOUT_MS", "Timeout setting for Request Timeout Ms"],
    ["CUSTOM_SETTING", "Custom setting"],
  ])("describes %s", (key, expected) => {
    expect(inferDescription(key)).toBe(expected);
  });

  it("formats prefixes case-insensitively and preserves an all-suffix key", () => {
    expect(prefixLabel("GOOGLE_GENAI_API_KEY", "_api_key")).toBe(
      "Google Genai",
    );
    expect(prefixLabel("_TOKEN", "_TOKEN")).toBe("_TOKEN");
    expect(prefixLabel("SERVICE.A_URL", ".A_URL")).toBe("Service");
  });

  it("exposes the accepted config keys and event streams", () => {
    expect(CONFIG_WRITE_ALLOWED_TOP_KEYS.size).toBe(40);
    expect(CONFIG_WRITE_ALLOWED_TOP_KEYS.has("connectors")).toBe(true);
    expect(CONFIG_WRITE_ALLOWED_TOP_KEYS.has("channels")).toBe(true);
    expect(CONFIG_WRITE_ALLOWED_TOP_KEYS.has("unknown")).toBe(false);
    expect(AGENT_EVENT_ALLOWED_STREAMS.has("voice-control")).toBe(true);
    expect(AGENT_EVENT_ALLOWED_STREAMS.has("unknown")).toBe(false);
  });
});

describe("secret aggregation helpers", () => {
  it.each([
    ["OPENAI_API_KEY", "ai-provider"],
    ["CUSTOM_API_KEY", "other"],
    ["BASE_RPC_URL", "blockchain"],
    ["SOLANA_NETWORK", "blockchain"],
    ["TELEGRAM_CHAT_ID", "connector"],
    ["SESSION_TOKEN", "auth"],
    ["PLAIN_VALUE", "other"],
  ])("categorizes %s as %s", (key, expected) => {
    expect(inferSecretCategory(key)).toBe(expected);
  });

  it("deduplicates shared secrets while preserving plugin order and enabled requirements", () => {
    process.env.SHARED_TOKEN = "1234567890";
    const result = aggregateSecrets([
      plugin("first-plugin", false, [
        parameter("SHARED_TOKEN", { required: true }),
        parameter("IGNORED", { sensitive: false }),
      ]),
      plugin("second-plugin", true, [
        parameter("SHARED_TOKEN", {
          description: "Second description",
          required: true,
        }),
      ]),
    ]);

    expect(result).toEqual([
      {
        key: "SHARED_TOKEN",
        description: "Authentication token for Shared",
        category: "auth",
        sensitive: true,
        required: true,
        isSet: true,
        maskedValue: "1234...7890",
        usedBy: [
          {
            pluginId: "first-plugin",
            pluginName: "First Plugin",
            enabled: false,
          },
          {
            pluginId: "second-plugin",
            pluginName: "Second Plugin",
            enabled: true,
          },
        ],
      },
    ]);
    expect(aggregateSecrets([])).toEqual([]);
  });
});

describe("plugin classification and metadata helpers", () => {
  it.each([
    ["openai", "ai-provider"],
    ["discord", "connector"],
    ["streaming", "streaming"],
    ["sql", "database"],
    ["unlisted", "feature"],
  ])("categorizes %s as %s", (id, expected) => {
    expect(categorizePlugin(id)).toBe(expected);
  });

  it("resolves setup guides for overrides, anchors, and unknown plugins", () => {
    expect(resolvePluginSetupGuideUrl("discord")).toBe(
      "https://docs.elizaos.ai/plugin-registry/platform/discord",
    );
    expect(resolvePluginSetupGuideUrl("openai")).toBe(
      "https://docs.eliza.ai/plugin-setup-guide#openai",
    );
    expect(resolvePluginSetupGuideUrl("unknown")).toBeUndefined();
  });

  it.each([
    ["elizaOS/eliza", "https://github.com/elizaOS/eliza"],
    ["git@github.com:elizaOS/eliza.git", "https://github.com/elizaOS/eliza"],
    [
      "git+https://github.com/elizaOS/eliza.git",
      "https://github.com/elizaOS/eliza",
    ],
    ["https://example.com/repo.git", "https://example.com/repo"],
    [
      { type: "git", url: " https://example.com/object.git " },
      "https://example.com/object",
    ],
    ["npm:package", undefined],
    [null, undefined],
  ])("normalizes repository value %#", (repository, expected) => {
    expect(normalizeRepositoryUrl(repository)).toBe(expected);
  });

  it("derives monorepo URLs only for elizaOS plugin packages", () => {
    expect(deriveElizaRepositoryUrl("@elizaos/plugin-sql", "plugin-sql")).toBe(
      "https://github.com/elizaos/eliza/tree/main/packages/plugin-sql",
    );
    expect(
      deriveElizaRepositoryUrl("plugin-sql", "plugin-sql"),
    ).toBeUndefined();
    expect(
      deriveElizaRepositoryUrl("@elizaos/plugin-sql", "packages/sql"),
    ).toBeUndefined();
  });

  it("normalizes, filters, and stably deduplicates metadata tags", () => {
    expect(normalizePluginMetadataTag("  Social & Chat  ")).toBe(
      "social-and-chat",
    );
    expect(normalizePluginMetadataTag("ElizaOS")).toBeNull();
    expect(normalizePluginMetadataTags("not-an-array")).toEqual([]);
    expect(
      normalizePluginMetadataTags(["Social", 3, "social", "AI Provider"]),
    ).toEqual(["social", "ai-provider"]);
    expect(
      mergePluginMetadataTags(["first", "tie"], ["tie", "second"]),
    ).toEqual(["first", "tie", "second"]);
  });

  it("derives plugin and connector tags for each connector family", () => {
    expect(pluginIdTags("google-chat")).toEqual([
      "google-chat",
      "google",
      "chat",
    ]);
    expect(connectorMetadataTags("discord")).toEqual([
      "social",
      "social-chat",
      "messaging",
    ]);
    expect(connectorMetadataTags("twitter")).toEqual(["social", "social-feed"]);
    expect(connectorMetadataTags("github")).toEqual(["integration"]);
  });

  it.each([
    ["openai", "Openai", "ai-provider", "Openai AI provider for Eliza agents"],
    [
      "discord",
      "Discord",
      "connector",
      "Discord connector for chatting with your agent",
    ],
    [
      "twitter",
      "Twitter",
      "connector",
      "Twitter social connector for connecting your agent to Twitter",
    ],
    [
      "custom",
      "Custom",
      "connector",
      "Custom connector plugin for Eliza agents",
    ],
    [
      "streaming",
      "Streaming",
      "streaming",
      "Streaming streaming destination for live agent broadcasts",
    ],
    ["sql", "Sql", "database", "Sql storage plugin for Eliza agents"],
    ["canvas", "Canvas", "app", "Canvas interactive app for Eliza agents"],
    ["search", "Search", "feature", "Search plugin for Eliza agents"],
  ] as const)(
    "builds the fallback description for %s",
    (id, name, category, expected) => {
      expect(resolvePluginDescription(id, name, category, undefined)).toBe(
        expected,
      );
    },
  );

  it("prefers trimmed metadata and formats scoped fallback names", () => {
    expect(
      resolvePluginDescription(
        "search",
        "Search",
        "feature",
        "  Custom copy  ",
      ),
    ).toBe("Custom copy");
    expect(
      resolvePluginDescription(
        "search-tools",
        "@scope/plugin",
        "feature",
        undefined,
      ),
    ).toBe("Search Tools plugin for Eliza agents");
    expect(formatPluginName("google-genai")).toBe("Google Genai");
  });

  it("merges supplied, category, connector, and id tags in stable order", () => {
    expect(
      resolvePluginTags("discord", "connector", ["Messaging", "custom"]),
    ).toEqual([
      "messaging",
      "custom",
      "connector",
      "social",
      "social-chat",
      "discord",
    ]);
  });

  it("reads and normalizes real package metadata from disk", () => {
    const packageRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "plugin-discovery-helpers-"),
    );
    const pluginRoot = path.join(packageRoot, "packages", "plugin-example");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        name: "@elizaos/plugin-example",
        version: "1.2.3",
        description: "  Example plugin  ",
        homepage: "https://example.com",
        repository: "elizaOS/example",
        keywords: ["ElizaOS", "Example & Tools"],
        logoUrl: "https://example.com/logo.png",
        elizaos: { configKeys: ["EXAMPLE_API_KEY"] },
        agentConfig: {
          pluginParameters: {
            EXAMPLE_API_KEY: { optional: false, options: ["one", 2] },
          },
          configUiHints: { EXAMPLE_API_KEY: { control: "password" } },
        },
      }),
    );

    try {
      expect(
        readBundledPluginPackageMetadata(
          packageRoot,
          "plugin-example",
          "@elizaos/plugin-example",
        ),
      ).toEqual({
        description: "Example plugin",
        homepage: "https://example.com",
        repository: "https://github.com/elizaOS/example",
        icon: "https://example.com/logo.png",
        tags: ["example-and-tools"],
        configKeys: ["EXAMPLE_API_KEY"],
        pluginParameters: {
          EXAMPLE_API_KEY: {
            type: "string",
            description: "API key for Example",
            required: true,
            sensitive: true,
            options: ["one"],
          },
        },
        configUiHints: { EXAMPLE_API_KEY: { control: "password" } },
      });
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
