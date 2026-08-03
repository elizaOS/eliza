/**
 * Connector `vault://` refs stay out of process.env and resolve into the
 * runtime settings map only.
 *
 * Covers the boot chain for connector credentials (audit gap #3,
 * ELIZA-VAULT-AUDIT-2026-07-30):
 *   config.connectors → applyConnectorSecretsToEnv (env mirror, plain values
 *   only) → collectConnectorEnvVars → resolveConnectorSecretSettings (vault
 *   read) → buildRuntimeSettingsProjection (settings overlay).
 *
 * Bidirectional proof:
 *   1. vault ref resolves → plugin-visible setting carries the plaintext AND
 *      process.env stays clean after the full boot-path env application.
 *   2. plain value unchanged → env mirror + settings behave exactly as before.
 *   3. missing/invalid ref → fail-closed: no setting, no env var, no secret
 *      material or vault internals in the reported failure strings.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import { collectConnectorEnvVars } from "../config/env-vars.ts";
import { applyConnectorSecretsToEnv } from "./eliza.ts";
import {
  formatVaultRef,
  isVaultRef,
  resolveConnectorSecretSettings,
  type VaultLike,
} from "./operations/vault-bridge.ts";
import {
  buildRuntimeSettingsProjection,
  resolveTelegramAccountTokenVaultSettings,
} from "./runtime-settings.ts";

const SECRET = "mfa.discord-bot-token-plaintext-1234567890";
const VAULT_KEY = "connectors.discord.token";

const ENV_KEYS = [
  "DISCORD_API_TOKEN",
  "DISCORD_BOT_TOKEN",
  "DISCORD_APPLICATION_ID",
  "TELEGRAM_BOT_TOKEN",
] as const;

let savedEnv: Record<string, string | undefined>;

function fakeVault(entries: Record<string, string>): VaultLike {
  return {
    has: (key: string) => Promise.resolve(key in entries),
    get: (key: string) => {
      const value = entries[key];
      if (value === undefined) {
        return Promise.reject(
          new Error(`vault internal: no row for ${key} in pglite store`),
        );
      }
      return Promise.resolve(value);
    },
  };
}

function throwingVault(): VaultLike {
  return {
    has: () => Promise.resolve(true),
    get: () =>
      Promise.reject(
        new Error(`vault backend exploded while decrypting ${SECRET}`),
      ),
  };
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("applyConnectorSecretsToEnv with vault refs", () => {
  it("never mirrors a vault:// ref (or its resolved value) into process.env", () => {
    const config = {
      connectors: {
        discord: { token: formatVaultRef(VAULT_KEY) },
      },
    } as unknown as ElizaConfig;

    applyConnectorSecretsToEnv(config);

    expect(process.env.DISCORD_API_TOKEN).toBeUndefined();
    expect(process.env.DISCORD_BOT_TOKEN).toBeUndefined();
  });

  it("does not mirror a ref supplied through the botToken alias either", () => {
    const config = {
      connectors: {
        discord: { botToken: formatVaultRef(VAULT_KEY) },
      },
    } as unknown as ElizaConfig;

    applyConnectorSecretsToEnv(config);

    expect(process.env.DISCORD_API_TOKEN).toBeUndefined();
    expect(process.env.DISCORD_BOT_TOKEN).toBeUndefined();
  });

  it("keeps mirroring plain token values exactly as before (backward compat)", () => {
    const config = {
      connectors: {
        discord: { token: "plain-discord-token" },
        telegram: { botToken: "plain-telegram-token" },
      },
    } as unknown as ElizaConfig;

    applyConnectorSecretsToEnv(config);

    expect(process.env.DISCORD_API_TOKEN).toBe("plain-discord-token");
    expect(process.env.DISCORD_BOT_TOKEN).toBe("plain-discord-token");
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("plain-telegram-token");
  });

  it("still mirrors non-secret connector fields when the token is a ref", () => {
    const config = {
      connectors: {
        discord: {
          token: formatVaultRef(VAULT_KEY),
          applicationId: "1234567890",
        },
      },
    } as unknown as ElizaConfig;

    applyConnectorSecretsToEnv(config);

    expect(process.env.DISCORD_APPLICATION_ID).toBe("1234567890");
    expect(process.env.DISCORD_API_TOKEN).toBeUndefined();
  });
});

describe("resolveConnectorSecretSettings", () => {
  it("resolves a discord token ref for both env aliases from one vault entry", async () => {
    const config = {
      connectors: { discord: { token: formatVaultRef(VAULT_KEY) } },
    } as unknown as ElizaConfig;
    const connectorEnvVars = collectConnectorEnvVars(config);

    const { resolved, failures } = await resolveConnectorSecretSettings(
      connectorEnvVars,
      fakeVault({ [VAULT_KEY]: SECRET }),
    );

    expect(resolved.DISCORD_API_TOKEN).toBe(SECRET);
    expect(resolved.DISCORD_BOT_TOKEN).toBe(SECRET);
    expect(failures).toEqual([]);
    // Resolution must not have touched the environment.
    expect(process.env.DISCORD_API_TOKEN).toBeUndefined();
    expect(process.env.DISCORD_BOT_TOKEN).toBeUndefined();
  });

  it("passes plain values through untouched (they are not vault reads)", async () => {
    const { resolved, failures } = await resolveConnectorSecretSettings(
      { TELEGRAM_BOT_TOKEN: "plain-token" },
      fakeVault({}),
    );

    expect(resolved).toEqual({});
    expect(failures).toEqual([]);
  });

  it("fails closed on a missing vault entry: no value, key names only", async () => {
    const { resolved, failures } = await resolveConnectorSecretSettings(
      { DISCORD_API_TOKEN: formatVaultRef("connectors.discord.missing") },
      fakeVault({}),
    );

    expect(resolved).toEqual({});
    expect(failures).toEqual([
      "DISCORD_API_TOKEN (vault://connectors.discord.missing)",
    ]);
  });

  it("fails closed on a malformed ref without echoing secret material", async () => {
    const { resolved, failures } = await resolveConnectorSecretSettings(
      { DISCORD_API_TOKEN: "vault://" },
      fakeVault({ [VAULT_KEY]: SECRET }),
    );

    // `vault://` with no key is not a valid ref, so it is treated as a plain
    // string by isVaultRef and skipped by the resolver entirely.
    expect(isVaultRef("vault://")).toBe(false);
    expect(resolved).toEqual({});
    expect(failures).toEqual([]);
  });

  it("redacts vault backend errors: failure strings carry no secret and no vault internals", async () => {
    const { resolved, failures } = await resolveConnectorSecretSettings(
      { DISCORD_API_TOKEN: formatVaultRef(VAULT_KEY) },
      throwingVault(),
    );

    expect(resolved).toEqual({});
    expect(failures).toHaveLength(1);
    const serialized = JSON.stringify(failures);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("exploded");
    expect(serialized).not.toContain("pglite");
    expect(failures[0]).toBe(`DISCORD_API_TOKEN (vault://${VAULT_KEY})`);
  });
});

describe("buildRuntimeSettingsProjection with connector refs", () => {
  it("delivers the resolved overlay to settings and drops unresolved sentinels", () => {
    const config = {
      connectors: {
        discord: { token: formatVaultRef(VAULT_KEY) },
        telegram: { botToken: formatVaultRef("connectors.telegram.missing") },
      },
    } as unknown as ElizaConfig;

    const settings = buildRuntimeSettingsProjection(config, {
      env: {} as NodeJS.ProcessEnv,
      connectorSecretsOverlay: {
        DISCORD_API_TOKEN: SECRET,
        DISCORD_BOT_TOKEN: SECRET,
        // telegram ref failed to resolve → deliberately absent
      },
    });

    // Resolved ref → plugin sees the plaintext via runtime settings.
    expect(settings.DISCORD_API_TOKEN).toBe(SECRET);
    expect(settings.DISCORD_BOT_TOKEN).toBe(SECRET);
    // Unresolved ref → fail-closed: neither the sentinel literal nor any
    // partial value reaches a plugin.
    expect(settings.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it("merges vault-resolved and plain Telegram account tokens in settings only", async () => {
    const accountSecret = "telegram-account-vault-secret";
    const config = {
      connectors: {
        telegram: {
          accounts: {
            ops: { botToken: "plain-ops-token" },
            alerts: {
              botToken: formatVaultRef("connectors.telegram.alerts.token"),
            },
          },
        },
      },
    } as unknown as ElizaConfig;

    applyConnectorSecretsToEnv(config);
    const { resolved, failures } =
      await resolveTelegramAccountTokenVaultSettings(
        config,
        fakeVault({
          "connectors.telegram.alerts.token": accountSecret,
        }),
      );
    const settings = buildRuntimeSettingsProjection(config, {
      env: {} as NodeJS.ProcessEnv,
      connectorSecretsOverlay: resolved,
    });

    expect(failures).toEqual([]);
    expect(JSON.parse(settings.TELEGRAM_ACCOUNT_TOKENS_JSON)).toEqual({
      ops: "plain-ops-token",
      alerts: accountSecret,
    });
    expect(process.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(Object.values(process.env)).not.toContain(accountSecret);
  });

  it("fails closed for a missing Telegram account vault ref", async () => {
    const config = {
      connectors: {
        telegram: {
          accounts: {
            alerts: {
              botToken: formatVaultRef("connectors.telegram.alerts.missing"),
            },
          },
        },
      },
    } as unknown as ElizaConfig;

    const { resolved, failures } =
      await resolveTelegramAccountTokenVaultSettings(config, fakeVault({}));

    expect(resolved).toEqual({});
    expect(failures).toEqual([
      'TELEGRAM_ACCOUNT_TOKENS_JSON["alerts"] (vault://connectors.telegram.alerts.missing)',
    ]);
  });

  it("keeps plain connector values in settings unchanged (backward compat)", () => {
    const config = {
      connectors: { discord: { token: "plain-discord-token" } },
    } as unknown as ElizaConfig;

    const settings = buildRuntimeSettingsProjection(config, {
      env: {} as NodeJS.ProcessEnv,
    });

    expect(settings.DISCORD_API_TOKEN).toBe("plain-discord-token");
    expect(settings.DISCORD_BOT_TOKEN).toBe("plain-discord-token");
  });
});

describe("end-to-end boot-shaped flow", () => {
  it("ref config: settings carry the secret, process.env is provably clean", async () => {
    const config = {
      connectors: { discord: { token: formatVaultRef(VAULT_KEY) } },
    } as unknown as ElizaConfig;

    // Boot step 2: env mirror (must skip the ref).
    applyConnectorSecretsToEnv(config);
    // Boot: overlay resolution (settings-only, mirrors
    // resolveConnectorSecretsOverlayForBoot without the host bridge).
    const { resolved } = await resolveConnectorSecretSettings(
      collectConnectorEnvVars(config),
      fakeVault({ [VAULT_KEY]: SECRET }),
    );
    // Boot step 7: runtime settings projection.
    const settings = buildRuntimeSettingsProjection(config, {
      env: {} as NodeJS.ProcessEnv,
      connectorSecretsOverlay: resolved,
    });

    expect(settings.DISCORD_API_TOKEN).toBe(SECRET);
    expect(settings.DISCORD_BOT_TOKEN).toBe(SECRET);
    // The whole point: nothing along the path wrote the secret (or the
    // sentinel) into the process environment.
    for (const key of ENV_KEYS) {
      expect(process.env[key]).toBeUndefined();
    }
    for (const value of Object.values(process.env)) {
      expect(value).not.toBe(SECRET);
    }
  });

  it("plain config: legacy env mirror still works end to end", async () => {
    const config = {
      connectors: { discord: { token: "plain-discord-token" } },
    } as unknown as ElizaConfig;

    applyConnectorSecretsToEnv(config);
    const { resolved } = await resolveConnectorSecretSettings(
      collectConnectorEnvVars(config),
      fakeVault({}),
    );
    const settings = buildRuntimeSettingsProjection(config, {
      env: {} as NodeJS.ProcessEnv,
      connectorSecretsOverlay: resolved,
    });

    expect(process.env.DISCORD_API_TOKEN).toBe("plain-discord-token");
    expect(process.env.DISCORD_BOT_TOKEN).toBe("plain-discord-token");
    expect(settings.DISCORD_API_TOKEN).toBe("plain-discord-token");
  });
});
