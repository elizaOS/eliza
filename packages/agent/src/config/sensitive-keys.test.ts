/**
 * Verifies the sensitive-config-key predicate and its downstream consumers:
 * isSensitiveConfigKey classification (secrets vs. non-secret token-count
 * settings), server-side redactConfigSecrets, and the sensitive marking of
 * plugin config UI hints by buildConfigSchema. Pure in-process assertions.
 */
import { describe, expect, it } from "vitest";
import { redactConfigSecrets } from "../api/server-helpers-config.ts";
import { buildConfigSchema } from "./schema.ts";
import { isSensitiveConfigKey } from "./sensitive-keys.ts";

describe("isSensitiveConfigKey", () => {
  it("covers server redaction and UI-sensitive config names", () => {
    for (const key of [
      "authorization",
      "credential",
      "seed_phrase",
      "seedPhrase",
      "connection_string",
      "connectionString",
      "accessToken",
    ]) {
      expect(isSensitiveConfigKey(key), key).toBe(true);
    }
  });

  it("does not classify non-secret token-count settings", () => {
    expect(isSensitiveConfigKey("maxTokens")).toBe(false);
    expect(isSensitiveConfigKey("max_tokens")).toBe(false);
    expect(isSensitiveConfigKey("max-tokens")).toBe(false);
    expect(isSensitiveConfigKey("models.large.maxTokens")).toBe(false);
    expect(isSensitiveConfigKey("models.large.max_tokens")).toBe(false);
  });
});

describe("sensitive config handling", () => {
  it("redacts keys covered by the shared predicate", () => {
    expect(
      redactConfigSecrets({
        seed_phrase: "seed",
        connection_string: "postgres://secret",
        maxTokens: 2048,
        max_tokens: 2048,
      }),
    ).toEqual({
      seed_phrase: "[REDACTED]",
      connection_string: "[REDACTED]",
      maxTokens: 2048,
      max_tokens: 2048,
    });
  });

  it("marks plugin config UI hints sensitive with the same predicate", () => {
    const schema = buildConfigSchema({
      plugins: [
        {
          id: "wallet",
          configUiHints: {
            seed_phrase: { label: "Seed phrase" },
            connection_string: { label: "Connection string" },
            maxTokens: { label: "Max tokens" },
            max_tokens: { label: "Max tokens" },
          },
        },
      ],
    });

    expect(
      schema.uiHints["plugins.entries.wallet.config.seed_phrase"]?.sensitive,
    ).toBe(true);
    expect(
      schema.uiHints["plugins.entries.wallet.config.connection_string"]
        ?.sensitive,
    ).toBe(true);
    expect(
      schema.uiHints["plugins.entries.wallet.config.maxTokens"]?.sensitive,
    ).toBeUndefined();
    expect(
      schema.uiHints["plugins.entries.wallet.config.max_tokens"]?.sensitive,
    ).toBeUndefined();
  });
});

describe("PAT credential names (#16564)", () => {
  it("classifies GH_PAT and dotted pat paths as sensitive", () => {
    expect(isSensitiveConfigKey("GH_PAT")).toBe(true);
    expect(isSensitiveConfigKey("github.gh_pat")).toBe(true);
  });

  it("never classifies PATH/FORMAT/PATTERN names", () => {
    for (const key of [
      "PATH",
      "XDG_DATA_PATH",
      "output.format",
      "TEMPLATE_PATTERN",
    ]) {
      expect(isSensitiveConfigKey(key)).toBe(false);
    }
  });
});

/**
 * W1-021: the GET /api/config masking contract must cover URL-shaped and misc
 * credential carriers, not just *KEY/*SECRET names — a `postgres://user:pw@…`
 * DSN or a Discord webhook URL is itself the credential.
 */
describe("URL-shaped and misc secret keys (W1-021)", () => {
  it("classifies DSN/URL/URI/webhook names as sensitive", () => {
    for (const key of [
      "DATABASE_URL",
      "POSTGRES_URL",
      "REDIS_URL",
      "MONGODB_URI",
      "DISCORD_WEBHOOK_URL",
      "webhookUrl",
      "app.database.dsn",
    ]) {
      expect(isSensitiveConfigKey(key), key).toBe(true);
    }
  });

  it("classifies misc credential names as sensitive", () => {
    for (const key of [
      "sessionKey",
      "mnemonic",
      "jwt",
      "bearer",
      "cookie",
      "encryptionKey",
      "masterKey",
      "sshKey",
      "signingKey",
      "accessKey",
      "SESSION_KEY",
      "ENCRYPTION_KEY",
    ]) {
      expect(isSensitiveConfigKey(key), key).toBe(true);
    }
  });

  it("keeps key-suffix lookalikes non-sensitive", () => {
    for (const key of [
      "monkey",
      "turnkey",
      "hotkey",
      "KEYBOARD",
      "maxTokens",
    ]) {
      expect(isSensitiveConfigKey(key), key).toBe(false);
    }
  });

  it("round-trips DATABASE_URL through GET /api/config redaction", () => {
    const redacted = redactConfigSecrets({
      env: {
        DATABASE_URL: "postgres://user:pw@host/db",
        LOG_LEVEL: "info",
      },
    }) as { env: Record<string, unknown> };
    expect(redacted.env.DATABASE_URL).toBe("[REDACTED]");
    expect(redacted.env.LOG_LEVEL).toBe("info");
  });
});

/**
 * W5-027: the classifier must cover the `passwd`/`passphrase` credential
 * names that the logger and core policies already treat as secret — a stored
 * `WALLET_PASSPHRASE` must never be served back in cleartext by /api/config.
 */
describe("passwd/passphrase credential names (W5-027)", () => {
  it("classifies passwd and passphrase names as sensitive", () => {
    for (const key of [
      "passwd",
      "PASSWD",
      "db.passwd",
      "passphrase",
      "PASSPHRASE",
      "WALLET_PASSPHRASE",
      "walletPassphrase",
    ]) {
      expect(isSensitiveConfigKey(key), key).toBe(true);
    }
  });

  it("redacts a stored WALLET_PASSPHRASE through GET /api/config", () => {
    const redacted = redactConfigSecrets({
      env: {
        WALLET_PASSPHRASE: "correct horse battery staple",
        LOG_LEVEL: "info",
      },
    }) as { env: Record<string, unknown> };
    expect(redacted.env.WALLET_PASSPHRASE).toBe("[REDACTED]");
    expect(redacted.env.LOG_LEVEL).toBe("info");
  });
});

/**
 * W10: concatenated all-caps `*KEY` names (MASTERKEY/SIGNINGKEY/SSHKEY/
 * ENCRYPTIONKEY) have no separator for the boundary rules and no lowercase
 * predecessor for the camelCase rule. An exact uppercase `AUTH` environment
 * key is a credential, while canonical lowercase auth containers and mode
 * discriminators must remain visible.
 */
describe("concatenated KEY names and bare AUTH (W10)", () => {
  it("classifies concatenated all-caps *KEY names as sensitive", () => {
    for (const key of [
      "MASTERKEY",
      "SIGNINGKEY",
      "SSHKEY",
      "ENCRYPTIONKEY",
      "masterkey",
      "wallet.SIGNINGKEY",
    ]) {
      expect(isSensitiveConfigKey(key), key).toBe(true);
    }
  });

  it("classifies uppercase AUTH without erasing structural lowercase auth", () => {
    expect(isSensitiveConfigKey("AUTH")).toBe(true);
    expect(isSensitiveConfigKey("service.AUTH")).toBe(true);
    expect(isSensitiveConfigKey("auth")).toBe(false);
    expect(isSensitiveConfigKey("service.auth")).toBe(false);
    for (const key of ["OAUTH", "oauth", "author", "AUTHORITY"]) {
      expect(isSensitiveConfigKey(key), key).toBe(false);
    }
  });

  it("redacts a stored MASTERKEY through GET /api/config", () => {
    const redacted = redactConfigSecrets({
      env: {
        MASTERKEY: "concatenated-master-secret",
        LOG_LEVEL: "info",
      },
    }) as { env: Record<string, unknown> };
    expect(redacted.env.MASTERKEY).toBe("[REDACTED]");
    expect(redacted.env.LOG_LEVEL).toBe("info");
  });

  it("preserves canonical auth metadata while redacting credential children", () => {
    expect(
      redactConfigSecrets({
        auth: {
          profiles: {
            work: {
              provider: "openai",
              mode: "oauth",
              email: "a@example.test",
            },
          },
          order: ["work"],
        },
        gateway: {
          auth: {
            mode: "token",
            token: "gateway-token-secret",
            password: "gateway-password-secret",
            allowTailscale: true,
          },
        },
        models: {
          providers: {
            local: { auth: "api-key", apiKey: "provider-secret" },
          },
        },
        env: { AUTH: "legacy-auth-secret" },
      }),
    ).toEqual({
      auth: {
        profiles: {
          work: { provider: "openai", mode: "oauth", email: "a@example.test" },
        },
        order: ["work"],
      },
      gateway: {
        auth: {
          mode: "token",
          token: "[REDACTED]",
          password: "[REDACTED]",
          allowTailscale: true,
        },
      },
      models: {
        providers: {
          local: { auth: "api-key", apiKey: "[REDACTED]" },
        },
      },
      env: { AUTH: "[REDACTED]" },
    });
  });
});
