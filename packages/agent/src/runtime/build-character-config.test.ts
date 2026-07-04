/**
 * Tests buildCharacterFromConfig's translation of an ElizaConfig into a runtime
 * Character: the Matrix connector secret/settings boundary (public identifiers
 * stay plain settings, credentials become redacted secrets) and passthrough of
 * per-agent settings and knowledge directories.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import { buildCharacterFromConfig } from "./build-character-config.ts";

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

describe("agent entry character passthrough", () => {
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
    } as ElizaConfig);

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
