import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateMasterKey } from "../src/crypto/envelope.js";
import { inMemoryMasterKey } from "../src/crypto/master-key.js";
import { createConfidant } from "../src/confidant.js";
import { EnvLegacyBackend } from "../src/backends/env-legacy.js";
import {
  ELIZA_PROVIDER_SECRET_IDS,
  isSubscriptionProviderId,
  mirrorLegacyEnvCredentials,
  providerIdForSecretId,
} from "../src/integrations/eliza-providers.js";
import { registerElizaProviderSchemas } from "../src/integrations/eliza-schema.js";
import {
  __resetSecretSchemaForTests,
  listSchema,
  lookupSchema,
} from "../src/secret-schema.js";

describe("integrations.eliza-providers", () => {
  let dir: string;
  let storePath: string;
  let auditPath: string;

  beforeEach(async () => {
    __resetSecretSchemaForTests();
    dir = await fs.mkdtemp(join(tmpdir(), "confidant-int-elz-"));
    storePath = join(dir, "confidant.json");
    auditPath = join(dir, "audit", "confidant.jsonl");
  });

  afterEach(async () => {
    __resetSecretSchemaForTests();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function makeConfidant(env?: NodeJS.ProcessEnv) {
    return createConfidant({
      storePath,
      auditLogPath: auditPath,
      masterKey: inMemoryMasterKey(generateMasterKey()),
      backends: [new EnvLegacyBackend(env)],
    });
  }

  it("ELIZA_PROVIDER_SECRET_IDS covers every catalog provider", () => {
    const expected = [
      "anthropic",
      "openai",
      "openrouter",
      "google",
      "google-genai",
      "groq",
      "xai",
      "deepseek",
      "mistral",
      "together",
      "zai",
      "elizacloud",
      "ollama",
      "anthropic-subscription",
      "openai-codex",
    ];
    for (const id of expected) {
      expect(ELIZA_PROVIDER_SECRET_IDS[id]).toBeDefined();
    }
  });

  it("every mapped SecretId follows the domain.subject.field convention", () => {
    for (const id of Object.values(ELIZA_PROVIDER_SECRET_IDS)) {
      expect(id.split(".").length).toBeGreaterThanOrEqual(3);
      expect(id).toMatch(/^[a-z]/);
    }
  });

  it("mirrorLegacyEnvCredentials registers every known provider", async () => {
    const env: NodeJS.ProcessEnv = {
      OPENROUTER_API_KEY: "sk-or-v1-test",
      OPENAI_API_KEY: "sk-test",
      ANTHROPIC_API_KEY: "sk-ant-test",
    };
    const confidant = makeConfidant(env);
    const result = await mirrorLegacyEnvCredentials(confidant, [
      { providerId: "openrouter", envVar: "OPENROUTER_API_KEY" },
      { providerId: "openai", envVar: "OPENAI_API_KEY" },
      { providerId: "anthropic", envVar: "ANTHROPIC_API_KEY" },
    ]);

    expect(result.migrated.map((m) => m.secretId).sort()).toEqual([
      "llm.anthropic.apiKey",
      "llm.openai.apiKey",
      "llm.openrouter.apiKey",
    ]);
    expect(result.skipped).toEqual([]);

    expect(await confidant.resolve("llm.openrouter.apiKey")).toBe("sk-or-v1-test");
    expect(await confidant.resolve("llm.openai.apiKey")).toBe("sk-test");
    expect(await confidant.resolve("llm.anthropic.apiKey")).toBe("sk-ant-test");
  });

  it("mirrorLegacyEnvCredentials skips unknown providers with structured reason", async () => {
    const confidant = makeConfidant({});
    const result = await mirrorLegacyEnvCredentials(confidant, [
      { providerId: "made-up-provider", envVar: "FAKE_KEY" },
      { providerId: "openrouter", envVar: "" },
    ]);
    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual([
      { providerId: "made-up-provider", reason: "unknown-provider" },
      { providerId: "openrouter", reason: "missing-env-var" },
    ]);
  });

  it("isSubscriptionProviderId flags device-bound credentials", () => {
    expect(isSubscriptionProviderId("anthropic-subscription")).toBe(true);
    expect(isSubscriptionProviderId("openai-codex")).toBe(true);
    expect(isSubscriptionProviderId("openrouter")).toBe(false);
    expect(isSubscriptionProviderId("anthropic")).toBe(false);
  });

  it("providerIdForSecretId is the inverse of the map", () => {
    expect(providerIdForSecretId("llm.openrouter.apiKey")).toBe("openrouter");
    expect(
      providerIdForSecretId("subscription.anthropic.accessToken"),
    ).toBe("anthropic-subscription");
    expect(providerIdForSecretId("nothing.like.this")).toBeNull();
  });
});

describe("integrations.eliza-schema", () => {
  beforeEach(() => __resetSecretSchemaForTests());
  afterEach(() => __resetSecretSchemaForTests());

  it("registers schema entries for every catalog provider", () => {
    registerElizaProviderSchemas();
    expect(lookupSchema("llm.openrouter.apiKey")).toMatchObject({
      label: "OpenRouter API Key",
      formatHint: "sk-or-v1-...",
      sensitive: true,
      pluginId: "@elizaos/plugin-openrouter",
    });
    expect(lookupSchema("llm.anthropic.apiKey")?.formatHint).toBe("sk-ant-...");
    expect(lookupSchema("llm.openai.apiKey")?.formatHint).toBe("sk-...");
    expect(listSchema().length).toBeGreaterThanOrEqual(13);
  });

  it("subscription tokens are owned by the matching provider plugin", () => {
    registerElizaProviderSchemas();
    expect(
      lookupSchema("subscription.anthropic.accessToken")?.pluginId,
    ).toBe("@elizaos/plugin-anthropic");
    expect(
      lookupSchema("subscription.openai.accessToken")?.pluginId,
    ).toBe("@elizaos/plugin-openai");
  });

  it("calling registerElizaProviderSchemas twice is a no-op (idempotent)", () => {
    registerElizaProviderSchemas();
    const first = listSchema().length;
    registerElizaProviderSchemas();
    const second = listSchema().length;
    expect(second).toBe(first);
  });
});

describe("integrations: end-to-end legacy bridge", () => {
  let dir: string;
  let storePath: string;
  let auditPath: string;

  beforeEach(async () => {
    __resetSecretSchemaForTests();
    dir = await fs.mkdtemp(join(tmpdir(), "confidant-int-bridge-"));
    storePath = join(dir, "confidant.json");
    auditPath = join(dir, "audit", "confidant.jsonl");
  });

  afterEach(async () => {
    __resetSecretSchemaForTests();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("real-world bootstrap: schema + bridge + scoped resolve through env", async () => {
    // 1. Host app registers the canonical Eliza schemas at boot.
    registerElizaProviderSchemas();

    // 2. Existing process.env credentials are mirrored as references.
    const env: NodeJS.ProcessEnv = {
      OPENROUTER_API_KEY: "sk-or-v1-real",
    };
    const confidant = createConfidant({
      storePath,
      auditLogPath: auditPath,
      masterKey: inMemoryMasterKey(generateMasterKey()),
      backends: [new EnvLegacyBackend(env)],
    });
    await mirrorLegacyEnvCredentials(confidant, [
      { providerId: "openrouter", envVar: "OPENROUTER_API_KEY" },
    ]);

    // 3. The OpenRouter plugin (now Confidant-aware) resolves through
    //    the runtime's scoped Confidant. Implicit grant fires because
    //    the schema attributes ownership to the matching plugin id.
    const scoped = confidant.scopeFor("@elizaos/plugin-openrouter");
    const apiKey = await scoped.resolve("llm.openrouter.apiKey");
    expect(apiKey).toBe("sk-or-v1-real");

    // 4. The audit log records the resolve with the correct skill,
    //    secret id, and source. Value is NOT in the log.
    const log = await fs.readFile(auditPath, "utf8");
    const lines = log.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({
      skill: "@elizaos/plugin-openrouter",
      secret: "llm.openrouter.apiKey",
      granted: true,
      source: "env-legacy",
    });
    expect(log).not.toContain("sk-or-v1-real");
  });
});
