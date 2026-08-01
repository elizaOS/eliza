/**
 * Tests buildCharacterFromConfig's translation of an ElizaConfig into a runtime
 * Character: the Matrix connector secret/settings boundary (public identifiers
 * stay plain settings, credentials become redacted secrets) and passthrough of
 * per-agent settings, canonical Slack connector policy, and knowledge directories.
 */
import {
  connectorAccountCredentialSettingKey,
  connectorBaseCredentialSettingKey,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import { ElizaSchema } from "../config/zod-schema.ts";
import { buildCharacterFromConfig } from "./build-character-config.ts";
import { applySandboxCharacterFromEnv } from "./sandbox-character.ts";

// Locks the secret/settings boundary for Matrix connector env vars. Putting a
// public identifier (e.g. MATRIX_VERIFY_ALLOWLIST = a user id) into
// character.settings.secrets makes the runtime's redaction layer blank its value
// out of all output — which once rendered a DM room name as
// "[REDACTED:MATRIX_VERIFY_ALLOWLIST]". Only genuine credentials may be secrets.
const MATRIX_ENV_KEYS = [
  "MATRIX_HOMESERVER",
  "MATRIX_USER_ID",
  "MATRIX_DEVICE_ID",
  "MATRIX_ACCESS_TOKEN",
  "MATRIX_PASSWORD",
  "MATRIX_VERIFY_ALLOWLIST",
  "MATRIX_ACCOUNTS",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(
    MATRIX_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
});

afterEach(() => {
  for (const key of MATRIX_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const CONFIG: ElizaConfig = {
  agents: { list: [{ name: "Tester", system: "x" }] },
} as ElizaConfig;

describe("Matrix connector secret/settings boundary", () => {
  it("routes public identifiers to settings and credentials to secrets", () => {
    process.env.MATRIX_HOMESERVER = "https://hs.example";
    process.env.MATRIX_USER_ID = "@bot:hs.example";
    process.env.MATRIX_DEVICE_ID = "DEVID";
    process.env.MATRIX_ACCESS_TOKEN = "tok-secret";
    process.env.MATRIX_PASSWORD = "pw-secret";
    process.env.MATRIX_VERIFY_ALLOWLIST = "@owner:matrix.org";
    process.env.MATRIX_ACCOUNTS = '[{"accountId":"work","accessToken":"t2"}]';

    const character = buildCharacterFromConfig(CONFIG);
    const settings = (character.settings ?? {}) as Record<string, unknown>;
    const secrets = (character.secrets ?? {}) as Record<string, unknown>;

    // Public identifiers are plain settings — resolvable by the plugin, never redacted.
    expect(settings.MATRIX_HOMESERVER).toBe("https://hs.example");
    expect(settings.MATRIX_USER_ID).toBe("@bot:hs.example");
    expect(settings.MATRIX_DEVICE_ID).toBe("DEVID");
    expect(settings.MATRIX_VERIFY_ALLOWLIST).toBe("@owner:matrix.org");

    // Public identifiers must NOT be secrets (else their values get redacted in output).
    expect("MATRIX_VERIFY_ALLOWLIST" in secrets).toBe(false);
    expect("MATRIX_USER_ID" in secrets).toBe(false);
    expect("MATRIX_HOMESERVER" in secrets).toBe(false);

    // Genuine credentials are secrets (redacted, never plain settings).
    expect(secrets.MATRIX_ACCESS_TOKEN).toBe("tok-secret");
    expect(secrets.MATRIX_PASSWORD).toBe("pw-secret");
    // MATRIX_ACCOUNTS JSON embeds per-account tokens, so it stays a secret.
    expect("MATRIX_ACCOUNTS" in secrets).toBe(true);
    expect("MATRIX_ACCESS_TOKEN" in settings).toBe(false);
    expect("MATRIX_PASSWORD" in settings).toBe(false);
  });

  it("omits absent Matrix env vars from both settings and secrets", () => {
    for (const key of MATRIX_ENV_KEYS) delete process.env[key];
    const character = buildCharacterFromConfig(CONFIG);
    const settings = (character.settings ?? {}) as Record<string, unknown>;
    const secrets = (character.secrets ?? {}) as Record<string, unknown>;
    expect("MATRIX_VERIFY_ALLOWLIST" in settings).toBe(false);
    expect("MATRIX_ACCESS_TOKEN" in secrets).toBe(false);
  });
});

describe("connector credential setting keys", () => {
  it("keeps distinct account identifiers in separate secret slots", () => {
    expect(
      connectorAccountCredentialSettingKey("slack", "support-east", "botToken"),
    ).not.toBe(
      connectorAccountCredentialSettingKey("slack", "support_east", "botToken"),
    );
  });
});

describe("agent entry character passthrough", () => {
  it("keeps runtime capability hints idempotent across config rebuilds", () => {
    const workflowHint =
      "You can create, activate, deactivate, and delete workflows via natural language using the workflow actions.";
    const taskHint =
      "You have a persistent task manager and can create scheduled or one-off tasks when the user asks; do not claim you lack tasks, memory, persistence, or scheduling when those actions are available.";
    const character = buildCharacterFromConfig({
      agents: {
        list: [
          {
            name: "Tester",
            system: [
              "You are Tester.",
              workflowHint,
              taskHint,
              workflowHint,
              taskHint,
            ].join("\n"),
          },
        ],
      },
    } as ElizaConfig);

    expect(character.system?.split(workflowHint)).toHaveLength(2);
    expect(character.system?.split(taskHint)).toHaveLength(2);
    expect(character.system).toContain("You are Tester.");
  });

  it("uses an injected sandbox identity when the prior default was not first", () => {
    const config = {
      agents: {
        list: [
          { name: "Secondary", system: "Secondary system.", default: false },
          { name: "Old primary", system: "Old primary system.", default: true },
        ],
      },
    } as ElizaConfig;

    applySandboxCharacterFromEnv(config, {
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({
        name: "Sol",
        system: "You are Sol.",
      }),
      SANDBOX_ROUTE_AGENT_ID: "route-id",
    });

    const character = buildCharacterFromConfig(config);
    expect(character.name).toBe("Sol");
    expect(character.system).toContain("You are Sol.");
    expect(character.system).not.toContain("Secondary system.");
  });

  it("preserves injected Discord auto-reply settings", () => {
    const character = buildCharacterFromConfig({
      agents: {
        list: [
          {
            id: "nyx",
            name: "Nyx",
            system: "You are Nyx.",
            settings: { discord: { autoReply: true } },
          },
        ],
      },
    } as unknown as ElizaConfig);

    expect(character.settings?.discord).toEqual({ autoReply: true });
    expect(character.settings?.ADVANCED_CAPABILITIES).toBe("true");
  });

  it("preserves injected knowledge directories for document ingestion", () => {
    const character = buildCharacterFromConfig({
      agents: {
        list: [
          {
            id: "nyx",
            name: "Nyx",
            system: "You are Nyx.",
            knowledge: [{ directory: "/knowledge" }],
          },
        ],
      },
    } as ElizaConfig);

    expect(character.documents).toEqual([
      {
        item: {
          case: "directory",
          value: { directory: "/knowledge" },
        },
      },
    ]);
  });
});

describe("connector policy projection", () => {
  it("merges partial account overrides without dropping base credentials", () => {
    const character = buildCharacterFromConfig({
      connectors: {
        slack: {
          accounts: {
            support: {
              botToken: "xoxb-base",
              appToken: "xapp-base",
              channels: { support: { enabled: true } },
            },
          },
        },
      },
      agents: {
        list: [
          {
            name: "Tester",
            system: "x",
            settings: {
              slack: {
                accounts: {
                  support: {
                    userToken: "xoxp-override",
                    channels: { support: { requireMention: true } },
                  },
                },
              },
            },
          },
        ],
      },
    } as ElizaConfig);

    expect(character.secrets).toMatchObject({
      [connectorAccountCredentialSettingKey("slack", "support", "botToken")]:
        "xoxb-base",
      [connectorAccountCredentialSettingKey("slack", "support", "appToken")]:
        "xapp-base",
      [connectorAccountCredentialSettingKey("slack", "support", "userToken")]:
        "xoxp-override",
    });
    const slackSettings = character.settings?.slack as
      | { accounts?: Record<string, unknown> }
      | undefined;
    expect(slackSettings?.accounts?.support).toMatchObject({
      channels: { support: { requireMention: true } },
    });
  });

  it("projects Slack policy while keeping every account credential secret", () => {
    const persisted = ElizaSchema.parse({
      connectors: {
        slack: {
          botToken: "xoxb-top-secret",
          appToken: "xapp-top-secret",
          userToken: "xoxp-top-secret",
          signingSecret: "top-signing-secret",
          channels: { ops: { requireMention: true, users: ["U123"] } },
          dm: { policy: "allowlist", allowFrom: ["U123"] },
          accounts: {
            support: {
              botToken: "xoxb-account-secret",
              appToken: "xapp-account-secret",
              userToken: "xoxp-account-secret",
              signingSecret: "account-signing-secret",
              channels: { support: { enabled: false } },
            },
          },
        },
      },
    });
    const slack = persisted.connectors?.slack;
    const character = buildCharacterFromConfig(
      persisted as unknown as ElizaConfig,
    );

    const projectedSlack = character.settings?.slack as typeof slack;
    expect(projectedSlack?.groupPolicy).toBe("allowlist");
    expect(projectedSlack?.channels).toEqual(slack?.channels);
    expect(projectedSlack?.accounts?.support?.channels).toEqual(
      slack?.accounts?.support?.channels,
    );
    expect(projectedSlack).not.toBe(slack);
    expect(projectedSlack?.channels).not.toBe(slack?.channels);

    const plainSettings = JSON.stringify(character.settings);
    for (const secret of [
      "xoxb-top-secret",
      "xapp-top-secret",
      "xoxp-top-secret",
      "top-signing-secret",
      "xoxb-account-secret",
      "xapp-account-secret",
      "xoxp-account-secret",
      "account-signing-secret",
    ]) {
      expect(plainSettings).not.toContain(secret);
    }
    expect(projectedSlack).not.toHaveProperty("botToken");
    expect(projectedSlack).not.toHaveProperty("appToken");
    expect(projectedSlack).not.toHaveProperty("userToken");
    expect(projectedSlack).not.toHaveProperty("signingSecret");
    expect(projectedSlack?.accounts?.support).not.toHaveProperty("botToken");
    expect(projectedSlack?.accounts?.support).not.toHaveProperty("appToken");
    expect(projectedSlack?.accounts?.support).not.toHaveProperty("userToken");
    expect(projectedSlack?.accounts?.support).not.toHaveProperty(
      "signingSecret",
    );

    const secrets = character.secrets ?? {};
    expect(secrets).not.toHaveProperty("SLACK_CONNECTOR_CREDENTIALS_JSON");
    for (const [field, value] of Object.entries({
      botToken: "xoxb-top-secret",
      appToken: "xapp-top-secret",
      userToken: "xoxp-top-secret",
      signingSecret: "top-signing-secret",
    })) {
      expect(secrets[connectorBaseCredentialSettingKey("slack", field)]).toBe(
        value,
      );
    }
    for (const [field, value] of Object.entries({
      botToken: "xoxb-account-secret",
      appToken: "xapp-account-secret",
      userToken: "xoxp-account-secret",
      signingSecret: "account-signing-secret",
    })) {
      expect(
        secrets[
          connectorAccountCredentialSettingKey("slack", "support", field)
        ],
      ).toBe(value);
    }
  });

  it("keeps canonical schema defaults strict without affecting env-only boot", () => {
    const persisted = ElizaSchema.parse({ connectors: { slack: {} } });
    const configured = buildCharacterFromConfig(
      persisted as unknown as ElizaConfig,
    );
    expect(configured.settings?.slack).toMatchObject({
      groupPolicy: "allowlist",
      mode: "socket",
      userTokenReadOnly: true,
    });

    const envOnly = buildCharacterFromConfig(CONFIG);
    expect(envOnly.settings?.slack).toBeUndefined();
  });
});
