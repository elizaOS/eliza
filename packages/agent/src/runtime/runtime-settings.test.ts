/**
 * Branch-level coverage for the pure runtime settings projection: the env-key
 * forwarding deny rules and every assembly branch of
 * `buildRuntimeSettingsProjection`, including spread-order precedence between
 * config vars, connector vars, overlays, named options, and wallet settings.
 * Deterministic unit harness: real collaborators (`collectConfigEnvVars`,
 * `collectConnectorEnvVars`, `isVaultRef`,
 * `resolveServiceRoutingInConfig`) driven by inline config literals, with
 * explicit `options.env` isolating each case from the machine environment.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import {
  buildRuntimeSettingsProjection,
  isEnvKeyAllowedForForwarding,
} from "./runtime-settings.ts";

const ELIZAOS_CLOUD_KEYS = [
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_NANO_MODEL",
  "ELIZAOS_CLOUD_MEDIUM_MODEL",
  "ELIZAOS_CLOUD_SMALL_MODEL",
  "ELIZAOS_CLOUD_LARGE_MODEL",
  "ELIZAOS_CLOUD_MEGA_MODEL",
  "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL",
  "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL",
  "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL",
  "ELIZAOS_CLOUD_PLANNER_MODEL",
] as const;

describe("isEnvKeyAllowedForForwarding", () => {
  it("allows ordinary plugin API keys including lowercase forms", () => {
    expect(isEnvKeyAllowedForForwarding("OPENAI_API_KEY")).toBe(true);
    expect(isEnvKeyAllowedForForwarding("openai_api_key")).toBe(true);
    expect(isEnvKeyAllowedForForwarding("TELEGRAM_BOT_TOKEN")).toBe(true);
  });

  it("rejects empty and whitespace-only keys", () => {
    expect(isEnvKeyAllowedForForwarding("")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("  ")).toBe(false);
  });

  it("blocks ALLOW_NO_DATABASE exactly in any case but allows near-matches", () => {
    expect(isEnvKeyAllowedForForwarding("ALLOW_NO_DATABASE")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("allow_no_database")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("ALLOW_NO_DATABASE_EXTRA")).toBe(true);
  });

  it("blocks PRIVATE_KEY at any position and case", () => {
    expect(isEnvKeyAllowedForForwarding("EVM_PRIVATE_KEY")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("MY_PRIVATE_KEY")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("PRIVATE_KEY_STORE")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("evm_private_key")).toBe(false);
  });

  it("blocks chain-prefixed keys only as prefixes", () => {
    expect(isEnvKeyAllowedForForwarding("EVM_RPC_URL")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("SOLANA_RPC_URL")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("solana_rpc_url")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("MY_EVM_KEY")).toBe(true);
    expect(isEnvKeyAllowedForForwarding("MY_SOLANA_KEY")).toBe(true);
  });

  it.each([
    ["SLACK_SIGNING_SECRET"],
    ["GENERIC_PASSWORD"],
    ["AWS_CREDENTIAL"],
    ["WALLET_MNEMONIC"],
    ["SEED_PHRASE_BACKUP"],
    ["api_secret_key"],
  ])("blocks secret-family substring %s", (key) => {
    expect(isEnvKeyAllowedForForwarding(key)).toBe(false);
  });

  it("blocks token names only as key suffixes", () => {
    expect(isEnvKeyAllowedForForwarding("GITHUB_ACCESS_TOKEN")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("X_REFRESH_TOKEN")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("MY_SESSION_TOKEN")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("FOO_AUTH_TOKEN")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("ACCESS_TOKEN_FILE")).toBe(true);
    expect(isEnvKeyAllowedForForwarding("MY_AUTH_TOKEN_V2")).toBe(true);
  });

  it.each([...ELIZAOS_CLOUD_KEYS])("blocks %s", (key) => {
    expect(isEnvKeyAllowedForForwarding(key)).toBe(false);
  });

  it("blocks cloud keys case-insensitively but allows near-misses", () => {
    expect(isEnvKeyAllowedForForwarding("elizaos_cloud_api_key")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("ELIZAOS_CLOUD_API_KEY_EXTRA")).toBe(
      true,
    );
  });
});

describe("buildRuntimeSettingsProjection", () => {
  it("emits exactly the fast-validation baseline for an empty config and env", () => {
    expect(
      buildRuntimeSettingsProjection({} as ElizaConfig, { env: {} }),
    ).toEqual({
      VALIDATION_LEVEL: "fast",
    });
  });

  it("copies SECRET_SALT into ENCRYPTION_SALT verbatim and omits blanks", () => {
    const salted = buildRuntimeSettingsProjection({} as ElizaConfig, {
      env: { SECRET_SALT: "salt-value" },
    });
    expect(salted.ENCRYPTION_SALT).toBe("salt-value");

    const empty = buildRuntimeSettingsProjection({} as ElizaConfig, {
      env: { SECRET_SALT: "" },
    });
    expect(empty.ENCRYPTION_SALT).toBeUndefined();

    const blankish = buildRuntimeSettingsProjection({} as ElizaConfig, {
      env: { SECRET_SALT: "  " },
    });
    expect(blankish.ENCRYPTION_SALT).toBeUndefined();
  });

  it("forwards allowed config env vars and drops sensitive ones", () => {
    const settings = buildRuntimeSettingsProjection(
      {
        env: {
          vars: {
            OPENAI_API_KEY: "openai-key",
            EVM_PRIVATE_KEY: "blocked-wallet-secret",
            GENERIC_PASSWORD: "blocked-password",
          },
        },
      } as ElizaConfig,
      { env: {} },
    );

    expect(settings.OPENAI_API_KEY).toBe("openai-key");
    expect(settings.EVM_PRIVATE_KEY).toBeUndefined();
    expect(settings.GENERIC_PASSWORD).toBeUndefined();
  });

  it("normalizes EMBEDDING_PROVIDER to trimmed lowercase and omits blanks", () => {
    const padded = buildRuntimeSettingsProjection({} as ElizaConfig, {
      env: { EMBEDDING_PROVIDER: " Local " },
    });
    expect(padded.EMBEDDING_PROVIDER).toBe("local");

    const empty = buildRuntimeSettingsProjection({} as ElizaConfig, {
      env: { EMBEDDING_PROVIDER: "" },
    });
    expect(empty.EMBEDDING_PROVIDER).toBeUndefined();

    const whitespace = buildRuntimeSettingsProjection({} as ElizaConfig, {
      env: { EMBEDDING_PROVIDER: "   " },
    });
    expect(whitespace.EMBEDDING_PROVIDER).toBeUndefined();
  });

  it("keeps plaintext connector values and drops unresolved vault:// refs", () => {
    const settings = buildRuntimeSettingsProjection(
      {
        connectors: {
          telegram: { botToken: "vault://telegram/token" },
          discord: { token: "discord-token" },
          whatsapp: { authDir: "vault://" },
        },
      } as ElizaConfig,
      { env: {} },
    );

    expect(settings.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(settings.DISCORD_API_TOKEN).toBe("discord-token");
    expect(settings.DISCORD_BOT_TOKEN).toBe("discord-token");
    expect(settings.WHATSAPP_AUTH_DIR).toBeUndefined();
  });

  it("lets the connector secrets overlay resolve refs and override earlier sources", () => {
    const settings = buildRuntimeSettingsProjection(
      {
        env: { vars: { OPENAI_API_KEY: "from-config-env" } },
        connectors: { telegram: { botToken: "vault://telegram/token" } },
      } as ElizaConfig,
      {
        env: {},
        connectorSecretsOverlay: {
          TELEGRAM_BOT_TOKEN: "resolved-telegram-token",
          OPENAI_API_KEY: "from-overlay",
        },
      },
    );

    expect(settings.TELEGRAM_BOT_TOKEN).toBe("resolved-telegram-token");
    expect(settings.OPENAI_API_KEY).toBe("from-overlay");
  });

  it("gives connector-derived keys precedence over config env vars", () => {
    const settings = buildRuntimeSettingsProjection(
      {
        env: { vars: { DISCORD_API_TOKEN: "from-config-env" } },
        connectors: { discord: { token: "from-connector" } },
      } as ElizaConfig,
      { env: {} },
    );

    expect(settings.DISCORD_API_TOKEN).toBe("from-connector");
  });

  it("projects named provider selections and omits blank ones", () => {
    const settings = buildRuntimeSettingsProjection({} as ElizaConfig, {
      env: {},
      preferredProviderId: "openai",
      brainProviderName: "",
      embeddingProviderName: "openai",
    });

    expect(settings.MODEL_PROVIDER).toBe("openai");
    expect(settings.ELIZA_EMBEDDING_PROVIDER).toBe("openai");
    expect(settings.ELIZA_BRAIN_PROVIDER).toBeUndefined();
  });

  it("projects the vision mode setting and omits blanks", () => {
    const on = buildRuntimeSettingsProjection({} as ElizaConfig, {
      env: {},
      visionModeSetting: "ON",
    });
    expect(on.VISION_MODE).toBe("ON");

    const blank = buildRuntimeSettingsProjection({} as ElizaConfig, {
      env: {},
      visionModeSetting: "",
    });
    expect(blank.VISION_MODE).toBeUndefined();
  });

  it("flags canonical capabilities per resolved route", () => {
    const llmOnly = buildRuntimeSettingsProjection(
      {
        serviceRouting: {
          llmText: { backend: "cerebras", transport: "direct" },
        },
      } as ElizaConfig,
      { env: {} },
    );
    expect(llmOnly.ELIZA_CANONICAL_LLM_TEXT_ENABLED).toBe("true");
    expect(llmOnly.ELIZA_CANONICAL_EMBEDDINGS_ENABLED).toBe("false");

    const embeddingsOnly = buildRuntimeSettingsProjection(
      {
        serviceRouting: {
          embeddings: { backend: "openai", transport: "direct" },
        },
      } as ElizaConfig,
      { env: {} },
    );
    expect(embeddingsOnly.ELIZA_CANONICAL_LLM_TEXT_ENABLED).toBe("false");
    expect(embeddingsOnly.ELIZA_CANONICAL_EMBEDDINGS_ENABLED).toBe("true");
  });

  it("reports both canonical flags disabled for an explicit unresolvable routing block", () => {
    const settings = buildRuntimeSettingsProjection(
      {
        serviceRouting: {},
      } as ElizaConfig,
      { env: {} },
    );

    expect(settings.ELIZA_CANONICAL_LLM_TEXT_ENABLED).toBe("false");
    expect(settings.ELIZA_CANONICAL_EMBEDDINGS_ENABLED).toBe("false");
  });

  it("ignores canonical routing inherited from the prototype", () => {
    const settings = buildRuntimeSettingsProjection(
      Object.create({
        serviceRouting: {
          llmText: { backend: "cerebras", transport: "direct" },
        },
      }) as ElizaConfig,
      { env: {} },
    );

    expect(settings.ELIZA_CANONICAL_LLM_TEXT_ENABLED).toBeUndefined();
    expect(settings.ELIZA_CANONICAL_EMBEDDINGS_ENABLED).toBeUndefined();
  });

  it("propagates routing resolution failures instead of fabricating settings", () => {
    const config: Record<string, unknown> = {};
    Object.defineProperty(config, "serviceRouting", {
      get() {
        throw new Error("routing resolver exploded");
      },
      enumerable: true,
    });

    expect(() =>
      buildRuntimeSettingsProjection(config as ElizaConfig, { env: {} }),
    ).toThrow("routing resolver exploded");
  });

  it("lets wallet settings override provider-derived keys", () => {
    const settings = buildRuntimeSettingsProjection({} as ElizaConfig, {
      env: {},
      preferredProviderId: "openai",
      walletSettings: { MODEL_PROVIDER: "wallet-provider" },
    });

    expect(settings.MODEL_PROVIDER).toBe("wallet-provider");
  });

  it("trims the admin entity id and omits blank ids", () => {
    const padded = buildRuntimeSettingsProjection(
      {
        agents: { defaults: { adminEntityId: "  entity-1  " } },
      } as ElizaConfig,
      { env: {} },
    );
    expect(padded.ELIZA_ADMIN_ENTITY_ID).toBe("entity-1");

    const blank = buildRuntimeSettingsProjection(
      {
        agents: { defaults: { adminEntityId: "   " } },
      } as ElizaConfig,
      { env: {} },
    );
    expect(blank.ELIZA_ADMIN_ENTITY_ID).toBeUndefined();

    const missing = buildRuntimeSettingsProjection(
      {
        agents: { defaults: {} },
      } as ElizaConfig,
      { env: {} },
    );
    expect(missing.ELIZA_ADMIN_ENTITY_ID).toBeUndefined();
  });

  it("serializes empty owner contacts, inbox triage, and connector admins as JSON", () => {
    const settings = buildRuntimeSettingsProjection(
      {
        agents: { defaults: { ownerContacts: {}, inboxTriage: {} } },
        roles: { connectorAdmins: {} },
      } as ElizaConfig,
      { env: {} },
    );

    expect(settings.ELIZA_OWNER_CONTACTS_JSON).toBe("{}");
    expect(settings.ELIZA_INBOX_TRIAGE_CONFIG_JSON).toBe("{}");
    expect(settings.ELIZA_ROLES_CONNECTOR_ADMINS_JSON).toBe("{}");
  });

  it("comma-joins skill lists and directories", () => {
    const joined = buildRuntimeSettingsProjection(
      {
        skills: {
          allowBundled: ["calendar", "notes"],
          denyBundled: ["browser"],
          load: { extraDirs: ["/a", "/b"] },
        },
      } as ElizaConfig,
      { env: {}, managedSkillsDir: "/state/skills" },
    );

    expect(joined.SKILLS_ALLOWLIST).toBe("calendar,notes");
    expect(joined.SKILLS_DENYLIST).toBe("browser");
    expect(joined.EXTRA_SKILLS_DIRS).toBe("/a,/b");
    expect(joined.SKILLS_DIR).toBe("/state/skills");
  });

  it("emits empty skill allowlists but omits empty extra dirs and null dirs", () => {
    const settings = buildRuntimeSettingsProjection(
      {
        skills: { allowBundled: [], denyBundled: [], load: { extraDirs: [] } },
      } as ElizaConfig,
      {
        env: {},
        bundledSkillsDir: null,
        workspaceSkillsDir: null,
      },
    );

    expect(settings.SKILLS_ALLOWLIST).toBe("");
    expect(settings.SKILLS_DENYLIST).toBe("");
    expect(settings.EXTRA_SKILLS_DIRS).toBeUndefined();
    expect(settings.BUNDLED_SKILLS_DIRS).toBeUndefined();
    expect(settings.WORKSPACE_SKILLS_DIR).toBeUndefined();
    expect(settings.SKILLS_DIR).toBeUndefined();
  });

  it("disables image description only for an explicit features.vision false", () => {
    const disabled = buildRuntimeSettingsProjection(
      {
        features: { vision: false },
      } as ElizaConfig,
      { env: {} },
    );
    expect(disabled.DISABLE_IMAGE_DESCRIPTION).toBe("true");

    const enabled = buildRuntimeSettingsProjection(
      {
        features: { vision: true },
      } as ElizaConfig,
      { env: {} },
    );
    expect(enabled.DISABLE_IMAGE_DESCRIPTION).toBeUndefined();

    const absent = buildRuntimeSettingsProjection(
      {
        features: {},
      } as ElizaConfig,
      { env: {} },
    );
    expect(absent.DISABLE_IMAGE_DESCRIPTION).toBeUndefined();
  });
});

describe("buildRuntimeSettingsProjection process.env fallback", () => {
  let savedSalt: string | undefined;

  beforeEach(() => {
    savedSalt = process.env.SECRET_SALT;
    process.env.SECRET_SALT = "salt-from-process";
  });

  afterEach(() => {
    if (savedSalt === undefined) delete process.env.SECRET_SALT;
    else process.env.SECRET_SALT = savedSalt;
  });

  it("reads SECRET_SALT from process.env when options.env is absent", () => {
    const settings = buildRuntimeSettingsProjection({} as ElizaConfig);

    expect(settings.VALIDATION_LEVEL).toBe("fast");
    expect(settings.ENCRYPTION_SALT).toBe("salt-from-process");
  });

  it("prefers an explicit options.env over process.env", () => {
    const explicitEmpty = buildRuntimeSettingsProjection({} as ElizaConfig, {
      env: {},
    });
    expect(explicitEmpty.ENCRYPTION_SALT).toBeUndefined();

    const explicitValue = buildRuntimeSettingsProjection({} as ElizaConfig, {
      env: { SECRET_SALT: "salt-from-options" },
    });
    expect(explicitValue.ENCRYPTION_SALT).toBe("salt-from-options");
  });
});
