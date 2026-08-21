/**
 * Unit test for runVaultBootstrap startup resilience: when only the
 * process.env mirroring step cannot reach the vault, boot must not fail — the
 * run resolves reporting the unreachable key as failed rather than throwing.
 * @elizaos/agent, @elizaos/core, and the registry are mocked, and the vault is
 * a hand-rolled stub whose set() always throws.
 */
import type { Vault } from "@elizaos/vault";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
});

vi.mock("@elizaos/agent", () => ({
  formatVaultRef: (key: string) => `vault://${key}`,
  isVaultRef: (value: string) => value.startsWith("vault://"),
  loadElizaConfig: () => ({}),
  persistConfigEnv: vi.fn(),
  readConfigEnv: vi.fn(async () => ({})),
  resolveStateDir: () => "/tmp/example-state",
  saveElizaConfig: vi.fn(),
}));

vi.mock("../registry", () => ({
  loadRegistry: () => ({ all: [] }),
}));

import type { ElizaConfig } from "@elizaos/agent/config/types.eliza";
import {
  migrateElizaJsonSecretsForTesting,
  runVaultBootstrap,
} from "./vault-bootstrap";

function createFailingVault(): Vault {
  return {
    set: async () => {
      throw new Error("vault unavailable");
    },
    setIfAbsent: async () => {
      throw new Error("vault unavailable");
    },
    setReference: async () => {},
    get: async () => "",
    reveal: async () => "",
    has: async () => false,
    remove: async () => {},
    quarantineUnreadable: async () => false,
    list: async () => [],
    describe: async () => null,
    stats: async () => ({
      total: 0,
      sensitive: 0,
      nonSensitive: 0,
      references: 0,
    }),
  };
}

function createRecordingVault(values: Map<string, string>): Vault {
  return {
    set: async (key, value) => {
      values.set(key, value);
    },
    setIfAbsent: async (key, value) => {
      if (values.has(key)) return false;
      values.set(key, value);
      return true;
    },
    setReference: async () => {},
    get: async (key) => values.get(key) ?? "",
    reveal: async (key) => values.get(key) ?? "",
    has: async (key) => values.has(key),
    remove: async (key) => {
      values.delete(key);
    },
    quarantineUnreadable: async () => false,
    list: async () => [],
    describe: async () => null,
    stats: async () => ({
      total: values.size,
      sensitive: values.size,
      nonSensitive: 0,
      references: 0,
    }),
  };
}

describe("runVaultBootstrap", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    process.env.ELIZA_API_TOKEN = "runtime-token";
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("does not fail startup when only process.env mirroring cannot reach the vault", async () => {
    await expect(
      runVaultBootstrap({ vault: createFailingVault() }),
    ).resolves.toEqual({
      migrated: 0,
      failed: ["ELIZA_API_TOKEN"],
    });
  });

  it("moves known top-level connector credentials to deterministic connector keys", async () => {
    const values = new Map<string, string>();
    const config = {
      connectors: {
        telegram: { botToken: "telegram-plaintext" },
        slack: {
          signingSecret: "slack-plaintext",
          botToken: "vault://connector.host.slack.default.botToken",
        },
      },
    };

    const result = await migrateElizaJsonSecretsForTesting(
      config as unknown as ElizaConfig,
      createRecordingVault(values),
    );

    expect(result.migrated).toEqual([
      "connector.host.telegram.default.botToken",
      "connector.host.slack.default.signingSecret",
    ]);
    expect(config.connectors.telegram.botToken).toBe(
      "vault://connector.host.telegram.default.botToken",
    );
    expect(config.connectors.slack.signingSecret).toBe(
      "vault://connector.host.slack.default.signingSecret",
    );
    expect(config.connectors.slack.botToken).toBe(
      "vault://connector.host.slack.default.botToken",
    );
    expect(values).toEqual(
      new Map([
        ["connector.host.telegram.default.botToken", "telegram-plaintext"],
        ["connector.host.slack.default.signingSecret", "slack-plaintext"],
      ]),
    );
  });
});
