import {
  captureDevCloudEnvAuthoritySnapshot,
  resetDevCloudEnvAuthorityForTests,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const secureStoreMocks = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  isAvailable: vi.fn(),
}));

vi.mock("../services/vault-mirror", () => ({
  sharedVault: () => ({
    has: async () => false,
    reveal: async () => {
      throw new Error("unexpected wallet vault reveal");
    },
    set: async () => undefined,
  }),
}));

vi.mock("./platform-secure-store-node", () => ({
  createNodePlatformSecureStore: secureStoreMocks.create,
  isWalletOsStoreReadEnabled: () => true,
}));

import { hydrateWalletKeysFromNodePlatformSecureStore } from "./hydrate-wallet-keys-from-platform-store.ts";

const ENV_KEYS = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "STEWARD_API_URL",
  "STEWARD_TENANT_ID",
  "STEWARD_AGENT_ID",
  "ELIZA_STEWARD_AGENT_ID",
  "STEWARD_API_KEY",
  "STEWARD_AGENT_TOKEN",
] as const;

describe("wallet platform-store hydration under dev Cloud authority", () => {
  let saved: Record<(typeof ENV_KEYS)[number], string | undefined>;

  beforeEach(() => {
    resetDevCloudEnvAuthorityForTests();
    saved = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    ) as Record<(typeof ENV_KEYS)[number], string | undefined>;
    for (const key of ENV_KEYS) delete process.env[key];
    secureStoreMocks.get.mockReset();
    secureStoreMocks.isAvailable.mockReset().mockResolvedValue(true);
    secureStoreMocks.create.mockReset().mockReturnValue({
      get: secureStoreMocks.get,
      isAvailable: secureStoreMocks.isAvailable,
    });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetDevCloudEnvAuthorityForTests();
  });

  it("does not read or project a pre-existing production keychain into default staging", async () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-default";
    captureDevCloudEnvAuthoritySnapshot();

    // Models values projected by a late persistence layer before the deferred
    // boot hydrate. The mocked platform store itself also contains production
    // credentials and must never be opened.
    process.env.STEWARD_API_URL = "https://eliza.app/steward";
    process.env.STEWARD_TENANT_ID = "elizacloud";
    process.env.STEWARD_AGENT_ID = "production-agent";
    process.env.STEWARD_API_KEY = "production-key";
    process.env.STEWARD_AGENT_TOKEN = "production-token";
    secureStoreMocks.get.mockImplementation(
      async (_vaultId: string, kind: string) =>
        kind.startsWith("steward.")
          ? { ok: true, value: "production-keychain-secret" }
          : { ok: false, reason: "not-found" },
    );

    await hydrateWalletKeysFromNodePlatformSecureStore();

    // The shared store may still be opened for the two local-wallet migration
    // slots. The Steward secret kinds are the forbidden reads.
    expect(secureStoreMocks.create).toHaveBeenCalledTimes(1);
    expect(secureStoreMocks.get.mock.calls.map((call) => call[1])).toEqual([
      "wallet.evm_private_key",
      "wallet.solana_private_key",
    ]);
    expect(process.env.STEWARD_API_URL).toBeUndefined();
    expect(process.env.STEWARD_TENANT_ID).toBeUndefined();
    expect(process.env.STEWARD_AGENT_ID).toBeUndefined();
    expect(process.env.STEWARD_API_KEY).toBeUndefined();
    expect(process.env.STEWARD_AGENT_TOKEN).toBeUndefined();
  });
});
