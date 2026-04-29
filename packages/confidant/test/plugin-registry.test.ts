import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetSecretSchemaForTests,
  lookupSchema,
} from "../src/secret-schema.js";
import {
  defaultFieldNameForEnvVar,
  defineSchemaFromRegistry,
  type PluginRegistryEntryLike,
} from "../src/integrations/plugin-registry.js";

describe("defineSchemaFromRegistry — third-party plugin self-registration", () => {
  beforeEach(() => __resetSecretSchemaForTests());
  afterEach(() => __resetSecretSchemaForTests());

  it("registers every type:secret field from a real elizaos-plugins entry", () => {
    // Hypothetical elizaos-plugins/plugin-discord registry entry shape.
    const discordEntry: PluginRegistryEntryLike = {
      id: "@elizaos/plugin-discord",
      config: {
        DISCORD_BOT_TOKEN: {
          type: "secret",
          sensitive: true,
          required: true,
          label: "Discord Bot Token",
          placeholder: "MTI3...",
        },
        DISCORD_APPLICATION_ID: {
          type: "string",
        },
        DISCORD_PUBLIC_KEY: {
          type: "secret",
          required: true,
        },
      },
    };

    const result = defineSchemaFromRegistry(discordEntry, {
      domain: "connector",
      subject: "discord",
    });

    expect(result.registered.map((r) => r.secretId).sort()).toEqual([
      "connector.discord.botToken",
      "connector.discord.publicKey",
    ]);
    expect(result.skipped).toEqual([
      { envVar: "DISCORD_APPLICATION_ID", reason: "not-secret-type" },
    ]);

    expect(lookupSchema("connector.discord.botToken")).toMatchObject({
      label: "Discord Bot Token",
      formatHint: "MTI3...",
      sensitive: true,
      pluginId: "@elizaos/plugin-discord",
    });
    expect(lookupSchema("connector.discord.publicKey")).toMatchObject({
      sensitive: true,
      pluginId: "@elizaos/plugin-discord",
    });
  });

  it("works for an LLM provider plugin", () => {
    const tencentEntry: PluginRegistryEntryLike = {
      id: "@elizaos/plugin-tencent",
      config: {
        TENCENT_API_KEY: { type: "secret", required: true },
        TENCENT_LARGE_MODEL: { type: "string" },
      },
    };
    const result = defineSchemaFromRegistry(tencentEntry, {
      domain: "llm",
      subject: "tencent",
    });
    expect(result.registered).toEqual([
      { envVar: "TENCENT_API_KEY", secretId: "llm.tencent.apiKey" },
    ]);
    expect(lookupSchema("llm.tencent.apiKey")?.pluginId).toBe(
      "@elizaos/plugin-tencent",
    );
  });

  it("works for a wallet plugin with multiple secret fields", () => {
    const cosmosEntry: PluginRegistryEntryLike = {
      id: "@elizaos/plugin-cosmos",
      config: {
        COSMOS_PRIVATE_KEY: { type: "secret", required: true },
        COSMOS_RPC_URL: { type: "string" },
        COSMOS_MNEMONIC: { type: "secret" },
      },
    };
    const result = defineSchemaFromRegistry(cosmosEntry, {
      domain: "wallet",
      subject: "cosmos",
    });
    expect(result.registered.map((r) => r.secretId).sort()).toEqual([
      "wallet.cosmos.mnemonic",
      "wallet.cosmos.privateKey",
    ]);
  });

  it("respects the `only` allowlist", () => {
    const entry: PluginRegistryEntryLike = {
      id: "@elizaos/plugin-multi",
      config: {
        MULTI_API_KEY: { type: "secret" },
        MULTI_OTHER_KEY: { type: "secret" },
        MULTI_DEBUG: { type: "boolean" },
      },
    };
    const result = defineSchemaFromRegistry(entry, {
      domain: "tool",
      subject: "multi",
      only: ["MULTI_API_KEY"],
    });
    expect(result.registered).toEqual([
      { envVar: "MULTI_API_KEY", secretId: "tool.multi.apiKey" },
    ]);
    expect(result.skipped).toContainEqual({
      envVar: "MULTI_OTHER_KEY",
      reason: "not-in-allowlist",
    });
  });

  it("respects an explicit pluginId override", () => {
    const entry: PluginRegistryEntryLike = {
      id: "@some/plugin-package",
      config: { FOO_API_KEY: { type: "secret" } },
    };
    defineSchemaFromRegistry(entry, {
      domain: "tool",
      subject: "foo",
      pluginId: "@vendor/plugin-foo",
    });
    expect(lookupSchema("tool.foo.apiKey")?.pluginId).toBe("@vendor/plugin-foo");
  });

  it("respects a fieldNameForEnvVar override", () => {
    const entry: PluginRegistryEntryLike = {
      id: "@elizaos/plugin-weird",
      config: {
        WEIRD_PRIMARY_TOKEN: { type: "secret" },
      },
    };
    defineSchemaFromRegistry(entry, {
      domain: "tool",
      subject: "weird",
      fieldNameForEnvVar: () => "primary",
    });
    expect(lookupSchema("tool.weird.primary")).toBeDefined();
  });

  it("throws if no plugin id is available", () => {
    const entry: PluginRegistryEntryLike = {
      // no id, no npmName
      config: { FOO_API_KEY: { type: "secret" } },
    };
    expect(() =>
      defineSchemaFromRegistry(entry, { domain: "tool", subject: "foo" }),
    ).toThrow(/no id or npmName/);
  });

  it("returns empty result for entries with no config block", () => {
    const result = defineSchemaFromRegistry(
      { id: "@elizaos/plugin-noop" },
      { domain: "tool", subject: "noop" },
    );
    expect(result.registered).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("calling registerSchema twice for the same plugin id is idempotent", () => {
    const entry: PluginRegistryEntryLike = {
      id: "@elizaos/plugin-idempotent",
      config: { IDEMPOTENT_API_KEY: { type: "secret" } },
    };
    defineSchemaFromRegistry(entry, {
      domain: "tool",
      subject: "idempotent",
    });
    expect(() =>
      defineSchemaFromRegistry(entry, {
        domain: "tool",
        subject: "idempotent",
      }),
    ).not.toThrow();
  });
});

describe("defaultFieldNameForEnvVar", () => {
  it("strips subject prefix and camel-cases the remainder", () => {
    expect(defaultFieldNameForEnvVar("DISCORD_BOT_TOKEN", "discord", "connector")).toBe(
      "botToken",
    );
    expect(defaultFieldNameForEnvVar("GITHUB_API_TOKEN", "github", "connector")).toBe(
      "apiToken",
    );
    expect(defaultFieldNameForEnvVar("OPENROUTER_API_KEY", "openrouter", "llm")).toBe(
      "apiKey",
    );
  });

  it("handles dashed subjects (e.g., google-genai)", () => {
    expect(
      defaultFieldNameForEnvVar(
        "GOOGLE_GENAI_API_KEY",
        "google-genai",
        "llm",
      ),
    ).toBe("apiKey");
  });

  it("falls back to camel-casing the full env var when no prefix matches", () => {
    expect(defaultFieldNameForEnvVar("UNRELATED_TOKEN", "discord", "connector")).toBe(
      "unrelatedToken",
    );
  });

  it("uses domain+subject prefix when present", () => {
    expect(
      defaultFieldNameForEnvVar(
        "CONNECTOR_DISCORD_API_KEY",
        "discord",
        "connector",
      ),
    ).toBe("apiKey");
  });
});
