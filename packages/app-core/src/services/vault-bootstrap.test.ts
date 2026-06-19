import type { Vault } from "@elizaos/vault";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@elizaos/agent", () => ({
  formatVaultRef: (key: string) => `vault://${key}`,
  isVaultRef: (value: string) => value.startsWith("vault://"),
  loadElizaConfig: () => ({}),
  persistConfigEnv: vi.fn(),
  readConfigEnv: vi.fn(async () => ({})),
  resolveStateDir: () => "/tmp/milady-state",
  saveElizaConfig: vi.fn(),
}));

vi.mock("../registry", () => ({
  loadRegistry: () => ({ all: [] }),
}));

import { runVaultBootstrap } from "./vault-bootstrap";

function createFailingVault(): Vault {
  return {
    set: async () => {
      throw new Error("vault unavailable");
    },
    setReference: async () => {},
    get: async () => "",
    reveal: async () => "",
    has: async () => false,
    remove: async () => {},
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
});
