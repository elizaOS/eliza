/**
 * Unit tests for collectConfigEnvVars and collectConnectorEnvVars: flattening
 * config.env (vars + top-level strings), CONNECTOR_ENV_MAP projection, Discord
 * token-first aliases, value normalization, and WhatsApp allow-list / account
 * authDir overrides. Drives the real module. Deterministic, no live services.
 */
import { describe, expect, it } from "vitest";
import { isBlockedEnvKey } from "./blocked-env-keys.ts";
import {
  CONNECTOR_ENV_MAP,
  collectConfigEnvVars,
  collectConnectorEnvVars,
} from "./env-vars.ts";
import type { ElizaConfig } from "./types.ts";

function configEnv(env: NonNullable<ElizaConfig["env"]>) {
  return collectConfigEnvVars({ env });
}

function connectorEnv(connectors: NonNullable<ElizaConfig["connectors"]>) {
  return collectConnectorEnvVars({ connectors });
}

describe("CONNECTOR_ENV_MAP", () => {
  it("exports a field-to-env mapping for every supported connector", () => {
    expect(Object.keys(CONNECTOR_ENV_MAP).sort()).toEqual(
      [
        "blooio",
        "discord",
        "discordLocal",
        "googlechat",
        "imessage",
        "mattermost",
        "msteams",
        "slack",
        "telegram",
        "telegramAccount",
        "whatsapp",
      ].sort(),
    );
  });

  it("maps Discord token aliases onto the same API token env key", () => {
    expect(CONNECTOR_ENV_MAP.discord.token).toBe("DISCORD_API_TOKEN");
    expect(CONNECTOR_ENV_MAP.discord.botToken).toBe("DISCORD_API_TOKEN");
  });

  it("maps WhatsApp authDir and sessionPath onto the same auth dir env key", () => {
    expect(CONNECTOR_ENV_MAP.whatsapp.authDir).toBe("WHATSAPP_AUTH_DIR");
    expect(CONNECTOR_ENV_MAP.whatsapp.sessionPath).toBe("WHATSAPP_AUTH_DIR");
  });

  it("does not map any destination env key that isBlockedEnvKey would drop", () => {
    for (const envMap of Object.values(CONNECTOR_ENV_MAP)) {
      for (const envKey of Object.values(envMap)) {
        expect(isBlockedEnvKey(envKey), envKey).toBe(false);
      }
    }
  });
});

describe("collectConfigEnvVars", () => {
  it("returns an empty record when cfg or cfg.env is missing", () => {
    expect(collectConfigEnvVars()).toEqual({});
    expect(collectConfigEnvVars({})).toEqual({});
    expect(collectConfigEnvVars({ env: undefined })).toEqual({});
  });

  it("copies nested vars and skips empty values", () => {
    expect(
      configEnv({
        vars: {
          OPENAI_API_KEY: "sk-test",
          EMPTY: "",
        },
      }),
    ).toEqual({ OPENAI_API_KEY: "sk-test" });
  });

  it("keeps whitespace-only nested vars (only empty string is dropped)", () => {
    expect(configEnv({ vars: { PADDED: "   " } })).toEqual({ PADDED: "   " });
  });

  it("copies top-level string env keys and skips shellEnv/vars", () => {
    expect(
      configEnv({
        vars: { FROM_VARS: "vars" },
        shellEnv: { enabled: true, timeoutMs: 1000 },
        FROM_TOP: "top",
      }),
    ).toEqual({ FROM_VARS: "vars", FROM_TOP: "top" });
  });

  it("lets a later top-level string overwrite a nested vars key of the same name", () => {
    expect(
      configEnv({
        vars: { SHARED: "from-vars" },
        SHARED: "from-top",
      }),
    ).toEqual({ SHARED: "from-top" });
  });

  it("skips top-level non-strings and whitespace-only strings", () => {
    expect(
      configEnv({
        BLANK: "  ",
        NESTED: { inner: "nope" },
        OK: "kept",
      }),
    ).toEqual({ OK: "kept" });
  });

  it("drops nested and top-level keys rejected by isBlockedEnvKey", () => {
    expect(
      configEnv({
        vars: {
          DATABASE_URL: "postgres://secret",
          GITHUB_TOKEN: "ghp_secret",
          SAFE_VAR: "ok",
        },
        LD_PRELOAD: "/tmp/evil.so",
        NPM_CONFIG_REGISTRY: "https://evil.example",
        SAFE_TOP: "ok-top",
      }),
    ).toEqual({ SAFE_VAR: "ok", SAFE_TOP: "ok-top" });
  });

  it("blocks whitespace-padded secret keys because isBlockedEnvKey trims", () => {
    expect(
      configEnv({
        vars: { " GITHUB_TOKEN": "padded-nested" },
        " DATABASE_URL ": "padded-top",
        PUBLIC: "yes",
      }),
    ).toEqual({ PUBLIC: "yes" });
  });
});

describe("collectConnectorEnvVars", () => {
  it("returns an empty record when connectors/channels are missing or not a map", () => {
    expect(collectConnectorEnvVars()).toEqual({});
    expect(collectConnectorEnvVars({})).toEqual({});
    expect(
      collectConnectorEnvVars({
        connectors: [],
      } as unknown as ElizaConfig),
    ).toEqual({});
    expect(
      collectConnectorEnvVars({
        connectors: "discord",
      } as unknown as ElizaConfig),
    ).toEqual({});
  });

  it("skips a missing connector, a non-object entry, and an array entry", () => {
    const env = collectConnectorEnvVars({
      connectors: {
        telegram: { botToken: "tg-token" },
        slack: null,
        discord: ["not", "a", "map"],
        unknown: { token: "ignored" },
      },
    } as unknown as ElizaConfig);

    expect(env).toEqual({ TELEGRAM_BOT_TOKEN: "tg-token" });
  });

  it("falls back to channels when connectors is absent", () => {
    const env = collectConnectorEnvVars({
      channels: {
        telegram: { botToken: "from-channels" },
      },
    } as unknown as ElizaConfig);
    expect(env.TELEGRAM_BOT_TOKEN).toBe("from-channels");
  });

  it("prefers connectors over channels when both are present", () => {
    const env = collectConnectorEnvVars({
      connectors: {
        telegram: { botToken: "from-connectors" },
      },
      channels: {
        telegram: { botToken: "from-channels" },
      },
    } as unknown as ElizaConfig);
    expect(env.TELEGRAM_BOT_TOKEN).toBe("from-connectors");
  });

  it("mirrors Discord token onto DISCORD_API_TOKEN and DISCORD_BOT_TOKEN", () => {
    const env = connectorEnv({
      discord: { token: "bot-token" },
    });
    expect(env.DISCORD_API_TOKEN).toBe("bot-token");
    expect(env.DISCORD_BOT_TOKEN).toBe("bot-token");
  });

  it("gives Discord token precedence over botToken so the generic loop cannot overwrite", () => {
    const env = connectorEnv({
      discord: { token: "from-token", botToken: "from-bot-token" },
    });
    expect(env.DISCORD_API_TOKEN).toBe("from-token");
    expect(env.DISCORD_BOT_TOKEN).toBe("from-token");
  });

  it("falls back to Discord botToken when token is missing or whitespace", () => {
    expect(
      connectorEnv({ discord: { botToken: "only-bot" } }).DISCORD_API_TOKEN,
    ).toBe("only-bot");
    expect(
      connectorEnv({
        discord: { token: "   ", botToken: "from-bot" },
      }).DISCORD_API_TOKEN,
    ).toBe("from-bot");
  });

  it("omits Discord token aliases when both token fields are empty", () => {
    const env = connectorEnv({
      discord: { token: "  ", botToken: "", applicationId: "app-id" },
    });
    expect(env.DISCORD_API_TOKEN).toBeUndefined();
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(env.DISCORD_APPLICATION_ID).toBe("app-id");
  });

  it("JSON-stringifies Discord ownerUserIds, including finite numbers, and drops junk", () => {
    const env = collectConnectorEnvVars({
      connectors: {
        discord: {
          ownerUserIds: [
            " 111 ",
            222,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            { id: "nope" },
            "  ",
            "",
          ],
        },
      },
    } as unknown as ElizaConfig);

    expect(env.ELIZA_DISCORD_OWNER_USER_IDS_JSON).toBe(
      JSON.stringify(["111", "222"]),
    );
  });

  it("omits owner snowflakes when the array is missing, not an array, or empty after filtering", () => {
    expect(
      connectorEnv({ discord: { token: "t" } })
        .ELIZA_DISCORD_OWNER_USER_IDS_JSON,
    ).toBeUndefined();
    expect(
      collectConnectorEnvVars({
        connectors: { discord: { ownerUserIds: "111" } },
      } as unknown as ElizaConfig).ELIZA_DISCORD_OWNER_USER_IDS_JSON,
    ).toBeUndefined();
    expect(
      collectConnectorEnvVars({
        connectors: { discord: { ownerUserIds: ["  ", Number.NaN] } },
      } as unknown as ElizaConfig).ELIZA_DISCORD_OWNER_USER_IDS_JSON,
    ).toBeUndefined();
  });

  it("normalizes string, finite number, boolean, and array connector fields", () => {
    const env = collectConnectorEnvVars({
      connectors: {
        discordLocal: {
          enabled: false,
          clientId: "  client-id  ",
          sendDelayMs: 0,
          scopes: ["identify", "  guilds  ", 42, Number.NaN, ""],
          messageChannelIds: [],
        },
      },
    } as unknown as ElizaConfig);

    expect(env.DISCORD_LOCAL_ENABLED).toBe("false");
    expect(env.DISCORD_LOCAL_CLIENT_ID).toBe("  client-id  ");
    expect(env.DISCORD_LOCAL_SEND_DELAY_MS).toBe("0");
    expect(env.DISCORD_LOCAL_SCOPES).toBe("identify,guilds,42");
    expect(env.DISCORD_LOCAL_MESSAGE_CHANNEL_IDS).toBeUndefined();
  });

  it("serializes true booleans and skips non-finite numbers and nested objects", () => {
    const env = collectConnectorEnvVars({
      connectors: {
        discordLocal: {
          enabled: true,
          sendDelayMs: Number.POSITIVE_INFINITY,
          clientSecret: { nested: true },
        },
        imessage: {
          pollIntervalMs: Number.NaN,
          enabled: true,
        },
      },
    } as unknown as ElizaConfig);

    expect(env.DISCORD_LOCAL_ENABLED).toBe("true");
    expect(env.DISCORD_LOCAL_SEND_DELAY_MS).toBeUndefined();
    expect(env.DISCORD_LOCAL_CLIENT_SECRET).toBeUndefined();
    expect(env.IMESSAGE_POLL_INTERVAL_MS).toBeUndefined();
    expect(env.IMESSAGE_ENABLED).toBe("true");
  });

  it("projects remaining connector families from a single populated config", () => {
    const env = connectorEnv({
      telegram: { botToken: "tg" },
      telegramAccount: { phone: "+1555", appId: 1234 },
      slack: { botToken: "xoxb", appToken: "xapp" },
      imessage: { cliPath: "/usr/bin/imsg", allowFrom: ["a", "b"] },
      msteams: { appId: "teams-id", appPassword: "teams-pw" },
      mattermost: { botToken: "mm-token", baseUrl: "https://mm.example" },
      googlechat: { serviceAccountKey: "{}" },
      blooio: { apiKey: "bloo", fromNumber: "+100", webhookPort: 8080 },
    });

    expect(env.TELEGRAM_BOT_TOKEN).toBe("tg");
    expect(env.TELEGRAM_ACCOUNT_PHONE).toBe("+1555");
    expect(env.TELEGRAM_ACCOUNT_APP_ID).toBe("1234");
    expect(env.SLACK_BOT_TOKEN).toBe("xoxb");
    expect(env.SLACK_APP_TOKEN).toBe("xapp");
    expect(env.IMESSAGE_CLI_PATH).toBe("/usr/bin/imsg");
    expect(env.IMESSAGE_ALLOW_FROM).toBe("a,b");
    expect(env.MSTEAMS_APP_ID).toBe("teams-id");
    expect(env.MSTEAMS_APP_PASSWORD).toBe("teams-pw");
    expect(env.MATTERMOST_BOT_TOKEN).toBe("mm-token");
    expect(env.MATTERMOST_BASE_URL).toBe("https://mm.example");
    expect(env.GOOGLE_CHAT_SERVICE_ACCOUNT_KEY).toBe("{}");
    expect(env.BLOOIO_API_KEY).toBe("bloo");
    expect(env.BLOOIO_PHONE_NUMBER).toBe("+100");
    expect(env.BLOOIO_WEBHOOK_PORT).toBe("8080");
  });

  it("lets WhatsApp sessionPath overwrite authDir, then the first enabled account overwrite both", () => {
    const env = collectConnectorEnvVars({
      connectors: {
        whatsapp: {
          authDir: "/from-auth-dir",
          sessionPath: "/from-session-path",
          dmPolicy: "open",
          accounts: {
            disabled: { enabled: false, authDir: "/disabled" },
            skip: "not-an-object",
            first: { enabled: true, authDir: " /from-account " },
            later: { authDir: "/later-account" },
          },
        },
      },
    } as unknown as ElizaConfig);

    expect(env.WHATSAPP_AUTH_DIR).toBe("/from-account");
    expect(env.WHATSAPP_DM_POLICY).toBe("open");
  });

  it("does not keep scanning WhatsApp accounts after the first enabled string authDir is blank", () => {
    const env = collectConnectorEnvVars({
      connectors: {
        whatsapp: {
          sessionPath: "/from-session-path",
          accounts: {
            empty: { enabled: true, authDir: "  " },
            later: { authDir: "/later-account" },
          },
        },
      },
    } as unknown as ElizaConfig);

    expect(env.WHATSAPP_AUTH_DIR).toBe("/from-session-path");
  });

  it("comma-joins WhatsApp allowFrom and groupAllowFrom after String() coercion", () => {
    const env = collectConnectorEnvVars({
      connectors: {
        whatsapp: {
          allowFrom: ["  alice  ", 7, "", "  "],
          groupAllowFrom: [" g1 ", "g2"],
        },
      },
    } as unknown as ElizaConfig);

    expect(env.WHATSAPP_ALLOW_FROM).toBe("alice,7");
    expect(env.WHATSAPP_GROUP_ALLOW_FROM).toBe("g1,g2");
  });

  it("omits WhatsApp allow-lists and authDir overrides that are empty or the wrong shape", () => {
    const env = collectConnectorEnvVars({
      connectors: {
        whatsapp: {
          authDir: "/kept",
          allowFrom: [],
          groupAllowFrom: ["  ", ""],
          accounts: [{ authDir: "/from-array" }],
        },
      },
    } as unknown as ElizaConfig);

    expect(env.WHATSAPP_AUTH_DIR).toBe("/kept");
    expect(env.WHATSAPP_ALLOW_FROM).toBeUndefined();
    expect(env.WHATSAPP_GROUP_ALLOW_FROM).toBeUndefined();
  });

  it("skips WhatsApp accounts that are not a map or have no enabled string authDir", () => {
    expect(
      collectConnectorEnvVars({
        connectors: {
          whatsapp: {
            authDir: "/kept",
            accounts: null,
          },
        },
      } as unknown as ElizaConfig).WHATSAPP_AUTH_DIR,
    ).toBe("/kept");
    expect(
      collectConnectorEnvVars({
        connectors: {
          whatsapp: {
            authDir: "/kept",
            accounts: {
              a: null,
              b: ["nope"],
              c: { enabled: false, authDir: "/no" },
              d: { authDir: 12 },
            },
          },
        },
      } as unknown as ElizaConfig).WHATSAPP_AUTH_DIR,
    ).toBe("/kept");
  });
});
