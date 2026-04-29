import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateMasterKey } from "../src/crypto/envelope.js";
import { inMemoryMasterKey } from "../src/crypto/master-key.js";
import { createConfidant } from "../src/confidant.js";
import { EnvLegacyBackend } from "../src/backends/env-legacy.js";
import {
  ELIZA_ENV_TO_SECRET_ID,
  ELIZA_PROVIDER_TO_SECRET_ID,
  envVarForSecretId,
  isDeviceBoundSecretId,
  isSubscriptionProviderId,
  mirrorLegacyEnvCredentials,
  providerIdForSecretId,
} from "../src/integrations/eliza-providers.js";
import { registerElizaSecretSchemas } from "../src/integrations/eliza-schema.js";
import {
  __resetSecretSchemaForTests,
  listSchema,
  lookupSchema,
} from "../src/secret-schema.js";

describe("integrations.eliza-providers — env-var map", () => {
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

  it("covers every domain elizaOS uses (LLM, connector, wallet, RPC, storage, music, tool, service)", () => {
    const domains = new Set<string>();
    for (const id of Object.values(ELIZA_ENV_TO_SECRET_ID)) {
      domains.add(id.split(".")[0] ?? "");
    }
    for (const expected of [
      "llm",
      "tts",
      "connector",
      "tool",
      "storage",
      "wallet",
      "rpc",
      "trading",
      "music",
      "service",
    ]) {
      expect(domains.has(expected)).toBe(true);
    }
  });

  it("registers a SecretId for every secret env var in the elizaOS catalog", () => {
    // Spot-checks across the spread of plugin types.
    const expectedEnvVars = [
      "OPENROUTER_API_KEY",
      "ANTHROPIC_API_KEY",
      "GROQ_API_KEY",
      "XAI_API_KEY",
      "DEEPSEEK_API_KEY",
      "MISTRAL_API_KEY",
      "TOGETHER_API_KEY",
      "ZAI_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GOOGLE_API_KEY",
      "AIGATEWAY_API_KEY",
      "AI_GATEWAY_API_KEY",
      "VERCEL_OIDC_TOKEN",
      "ELIZAOS_CLOUD_API_KEY",
      "ELIZAOS_CLOUD_EMBEDDING_API_KEY",
      "ELEVENLABS_API_KEY",
      "GITHUB_API_TOKEN",
      "GITHUB_WEBHOOK_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
      "LINEAR_API_KEY",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_ACCOUNT_SID",
      "ROBLOX_API_KEY",
      "ROBLOX_WEBHOOK_SECRET",
      "X_API_KEY",
      "X_API_SECRET",
      "X_ACCESS_TOKEN",
      "X_BEARER_TOKEN",
      "X_ACCESS_TOKEN_SECRET",
      "N8N_API_KEY",
      "CAPSOLVER_API_KEY",
      "BROWSERBASE_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "WALLET_SECRET_SALT",
      "WALLET_SECRET_KEY",
      "WALLET_PRIVATE_KEY",
      "EVM_PRIVATE_KEY",
      "SOLANA_PRIVATE_KEY",
      "HEDERA_PRIVATE_KEY",
      "POLYMARKET_PRIVATE_KEY",
      "ALCHEMY_API_KEY",
      "INFURA_API_KEY",
      "ANKR_API_KEY",
      "HELIUS_API_KEY",
      "BIRDEYE_API_KEY",
      "JUPITER_API_KEY",
      "MORALIS_API_KEY",
      "COINGECKO_API_KEY",
      "DEXSCREENER_API_KEY",
      "ZEROEX_API_KEY",
      "CLOB_API_KEY",
      "CLOB_API_SECRET",
      "CLOB_API_PASSPHRASE",
      "LASTFM_API_KEY",
      "GENIUS_API_KEY",
      "THEAUDIODB_API_KEY",
      "SPOTIFY_CLIENT_SECRET",
      "ACP_GATEWAY_TOKEN",
      "ACP_GATEWAY_PASSWORD",
      "BLOOIO_API_KEY",
      "BLOOIO_WEBHOOK_SECRET",
      "MOLTBOOK_TOKEN",
    ];
    for (const envVar of expectedEnvVars) {
      expect(ELIZA_ENV_TO_SECRET_ID[envVar]).toBeDefined();
    }
  });

  it("every mapped SecretId follows the domain.subject.field convention", () => {
    for (const id of Object.values(ELIZA_ENV_TO_SECRET_ID)) {
      expect(id.split(".").length).toBeGreaterThanOrEqual(3);
      expect(id).toMatch(/^[a-z]/);
    }
    for (const id of Object.values(ELIZA_PROVIDER_TO_SECRET_ID)) {
      expect(id.split(".").length).toBeGreaterThanOrEqual(3);
      expect(id).toMatch(/^[a-z]/);
    }
  });

  it("LLM env vars and connector env vars don't collide on `xai` vs X/Twitter", () => {
    // xAI (the LLM) and X (the social network) both have plugins; the
    // env-var prefixes XAI_ and X_ disambiguate them. Make sure they
    // don't end up in the same domain.
    expect(ELIZA_ENV_TO_SECRET_ID.XAI_API_KEY?.startsWith("llm.")).toBe(true);
    expect(ELIZA_ENV_TO_SECRET_ID.X_API_KEY?.startsWith("connector.")).toBe(
      true,
    );
  });

  it("mirrorLegacyEnvCredentials handles a multi-domain credential set", async () => {
    const env: NodeJS.ProcessEnv = {
      OPENROUTER_API_KEY: "sk-or-v1-test",
      EVM_PRIVATE_KEY: "0xABC",
      AWS_ACCESS_KEY_ID: "AKIA-TEST",
      ELEVENLABS_API_KEY: "el-test",
      GITHUB_API_TOKEN: "ghp-test",
    };
    const confidant = makeConfidant(env);
    const result = await mirrorLegacyEnvCredentials(confidant, [
      { providerId: "openrouter", envVar: "OPENROUTER_API_KEY" },
      { providerId: "evm", envVar: "EVM_PRIVATE_KEY" },
      { providerId: "s3-storage", envVar: "AWS_ACCESS_KEY_ID" },
      { providerId: "elevenlabs", envVar: "ELEVENLABS_API_KEY" },
      { providerId: "github", envVar: "GITHUB_API_TOKEN" },
    ]);

    expect(result.migrated.map((m) => m.secretId).sort()).toEqual([
      "connector.github.apiToken",
      "llm.openrouter.apiKey",
      "storage.s3.accessKeyId",
      "tts.elevenlabs.apiKey",
      "wallet.evm.privateKey",
    ]);
    expect(result.skipped).toEqual([]);

    // Each resolves through the env-legacy backend.
    expect(await confidant.resolve("llm.openrouter.apiKey")).toBe("sk-or-v1-test");
    expect(await confidant.resolve("wallet.evm.privateKey")).toBe("0xABC");
    expect(await confidant.resolve("storage.s3.accessKeyId")).toBe("AKIA-TEST");
    expect(await confidant.resolve("tts.elevenlabs.apiKey")).toBe("el-test");
    expect(await confidant.resolve("connector.github.apiToken")).toBe("ghp-test");
  });

  it("mirrorLegacyEnvCredentials reports skipped entries with structured reasons", async () => {
    const confidant = makeConfidant({});
    const result = await mirrorLegacyEnvCredentials(confidant, [
      { providerId: "made-up-provider", envVar: "FAKE_KEY" },
      { providerId: "openrouter", envVar: "" },
    ]);
    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual([
      {
        providerId: "made-up-provider",
        envVar: "FAKE_KEY",
        reason: "unknown-env-var",
      },
      { providerId: "openrouter", reason: "missing-env-var" },
    ]);
  });

  it("isSubscriptionProviderId flags device-bound credentials", () => {
    expect(isSubscriptionProviderId("anthropic-subscription")).toBe(true);
    expect(isSubscriptionProviderId("openai-codex")).toBe(true);
    expect(isSubscriptionProviderId("openrouter")).toBe(false);
    expect(isSubscriptionProviderId("anthropic")).toBe(false);
  });

  it("isDeviceBoundSecretId flags subscription tokens AND wallet keys", () => {
    expect(isDeviceBoundSecretId("subscription.anthropic.accessToken")).toBe(true);
    expect(isDeviceBoundSecretId("subscription.openai.accessToken")).toBe(true);
    expect(isDeviceBoundSecretId("wallet.evm.privateKey")).toBe(true);
    expect(isDeviceBoundSecretId("wallet.solana.privateKey")).toBe(true);
    expect(isDeviceBoundSecretId("wallet.default.secretSalt")).toBe(true);
    expect(isDeviceBoundSecretId("llm.openrouter.apiKey")).toBe(false);
    expect(isDeviceBoundSecretId("connector.github.apiToken")).toBe(false);
  });

  it("providerIdForSecretId is the inverse of the provider map", () => {
    expect(providerIdForSecretId("llm.openrouter.apiKey")).toBe("openrouter");
    expect(
      providerIdForSecretId("subscription.anthropic.accessToken"),
    ).toBe("anthropic-subscription");
    expect(providerIdForSecretId("nothing.like.this")).toBeNull();
  });

  it("envVarForSecretId is the inverse of the env-var map", () => {
    expect(envVarForSecretId("llm.openrouter.apiKey")).toBe("OPENROUTER_API_KEY");
    expect(envVarForSecretId("wallet.evm.privateKey")).toBe("EVM_PRIVATE_KEY");
    expect(envVarForSecretId("connector.github.apiToken")).toBe("GITHUB_API_TOKEN");
    expect(envVarForSecretId("nothing.like.this")).toBeNull();
  });
});

describe("integrations.eliza-schema — full catalog", () => {
  beforeEach(() => __resetSecretSchemaForTests());
  afterEach(() => __resetSecretSchemaForTests());

  it("registerElizaSecretSchemas registers all known SecretIds", () => {
    registerElizaSecretSchemas();
    // The schema includes every distinct SecretId in the env map plus
    // the two subscription tokens — that's > 50 entries.
    expect(listSchema().length).toBeGreaterThanOrEqual(50);

    // Spot-check across domains.
    expect(lookupSchema("llm.openrouter.apiKey")).toMatchObject({
      formatHint: "sk-or-v1-...",
      sensitive: true,
      pluginId: "@elizaos/plugin-openrouter",
    });
    expect(lookupSchema("connector.github.apiToken")).toMatchObject({
      sensitive: true,
      pluginId: "@elizaos/plugin-github",
    });
    expect(lookupSchema("wallet.evm.privateKey")).toMatchObject({
      sensitive: true,
      pluginId: "@elizaos/plugin-evm",
    });
    expect(lookupSchema("storage.s3.accessKeyId")).toMatchObject({
      sensitive: true,
      pluginId: "@elizaos/plugin-s3-storage",
    });
    expect(lookupSchema("tts.elevenlabs.apiKey")).toMatchObject({
      sensitive: true,
      pluginId: "@elizaos/plugin-elevenlabs",
    });
    expect(lookupSchema("rpc.helius.apiKey")).toMatchObject({
      sensitive: true,
      pluginId: "@elizaos/plugin-solana",
    });
  });

  it("attributes subscription tokens to the matching provider plugin", () => {
    registerElizaSecretSchemas();
    expect(
      lookupSchema("subscription.anthropic.accessToken")?.pluginId,
    ).toBe("@elizaos/plugin-anthropic");
    expect(
      lookupSchema("subscription.openai.accessToken")?.pluginId,
    ).toBe("@elizaos/plugin-openai");
  });

  it("registerElizaSecretSchemas is idempotent", () => {
    registerElizaSecretSchemas();
    const first = listSchema().length;
    registerElizaSecretSchemas();
    const second = listSchema().length;
    expect(second).toBe(first);
  });

  it("labels are human-readable across domains", () => {
    registerElizaSecretSchemas();
    const samples = [
      ["llm.openrouter.apiKey", "OpenRouter"],
      ["connector.github.apiToken", "GitHub"],
      ["wallet.evm.privateKey", "EVM"],
      ["storage.s3.accessKeyId", "S3"],
      ["tts.elevenlabs.apiKey", "ElevenLabs"],
      ["rpc.helius.apiKey", "Helius"],
    ] as const;
    for (const [id, expectedFragment] of samples) {
      expect(lookupSchema(id)?.label).toContain(expectedFragment);
    }
  });
});

describe("integrations: end-to-end legacy bridge across domains", () => {
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

  it("bootstrap with a multi-domain credential set: LLM + connector + wallet", async () => {
    registerElizaSecretSchemas();

    const env: NodeJS.ProcessEnv = {
      OPENROUTER_API_KEY: "sk-or-v1-real",
      GITHUB_API_TOKEN: "ghp-real",
      EVM_PRIVATE_KEY: "0xDEADBEEF",
    };
    const confidant = createConfidant({
      storePath,
      auditLogPath: auditPath,
      masterKey: inMemoryMasterKey(generateMasterKey()),
      backends: [new EnvLegacyBackend(env)],
    });
    await mirrorLegacyEnvCredentials(confidant, [
      { providerId: "openrouter", envVar: "OPENROUTER_API_KEY" },
      { providerId: "github", envVar: "GITHUB_API_TOKEN" },
      { providerId: "evm", envVar: "EVM_PRIVATE_KEY" },
    ]);

    // Each plugin gets implicit access to its own credential.
    const openrouter = confidant.scopeFor("@elizaos/plugin-openrouter");
    const github = confidant.scopeFor("@elizaos/plugin-github");
    const evm = confidant.scopeFor("@elizaos/plugin-evm");

    expect(await openrouter.resolve("llm.openrouter.apiKey")).toBe("sk-or-v1-real");
    expect(await github.resolve("connector.github.apiToken")).toBe("ghp-real");
    expect(await evm.resolve("wallet.evm.privateKey")).toBe("0xDEADBEEF");

    // Cross-plugin access is denied.
    const { PermissionDeniedError } = await import(
      "../src/policy/grants.js"
    );
    await expect(
      openrouter.resolve("connector.github.apiToken"),
    ).rejects.toThrow(PermissionDeniedError);
    await expect(github.resolve("wallet.evm.privateKey")).rejects.toThrow(
      PermissionDeniedError,
    );

    // Audit log records every resolve with skill + secret + outcome.
    // No credential value appears.
    const log = await fs.readFile(auditPath, "utf8");
    expect(log).not.toContain("sk-or-v1-real");
    expect(log).not.toContain("ghp-real");
    expect(log).not.toContain("0xDEADBEEF");
  });
});
