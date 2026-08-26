/**
 * Deterministic coverage for packaged provider hydration from protected Vault.
 * No real credential, provider request, or process environment mutation occurs.
 */

import { describe, expect, it, vi } from "vitest";
import { hydrateSelectedProviderCredentialFromVault } from "./provider-vault-credential.ts";

function fakeVault(entries: Record<string, string>) {
  return {
    has: vi.fn(async (key: string) => Object.hasOwn(entries, key)),
    reveal: vi.fn(async (key: string) => {
      const value = entries[key];
      if (value === undefined) throw new Error("missing test credential");
      return value;
    }),
  };
}

describe("hydrateSelectedProviderCredentialFromVault", () => {
  it("prefers the canonical key and keeps process.env unchanged", async () => {
    const env: NodeJS.ProcessEnv = {};
    const settingsOverlay: Record<string, string> = {};
    const vault = fakeVault({
      "providers.cerebras.api-key": "canonical-test-value",
      CEREBRAS_API_KEY: "legacy-test-value",
    });

    await expect(
      hydrateSelectedProviderCredentialFromVault({
        providerId: "cerebras",
        vault,
        env,
        settingsOverlay,
      }),
    ).resolves.toEqual({
      status: "hydrated",
      providerId: "cerebras",
      envKey: "CEREBRAS_API_KEY",
      vaultKey: "providers.cerebras.api-key",
    });
    expect(env.CEREBRAS_API_KEY).toBeUndefined();
    expect(settingsOverlay.CEREBRAS_API_KEY).toBe("canonical-test-value");
  });

  it("supports the legacy protected env-key entry", async () => {
    const settingsOverlay: Record<string, string> = {};
    const result = await hydrateSelectedProviderCredentialFromVault({
      providerId: "cerebras",
      vault: fakeVault({ CEREBRAS_API_KEY: "legacy-test-value" }),
      env: {},
      settingsOverlay,
    });

    expect(result).toMatchObject({
      status: "hydrated",
      vaultKey: "CEREBRAS_API_KEY",
    });
    expect(settingsOverlay.CEREBRAS_API_KEY).toBe("legacy-test-value");
  });

  it("does not read Vault when process env already owns the credential", async () => {
    const vault = fakeVault({
      "providers.cerebras.api-key": "canonical-test-value",
    });
    const settingsOverlay: Record<string, string> = {};

    await expect(
      hydrateSelectedProviderCredentialFromVault({
        providerId: "cerebras",
        vault,
        env: { CEREBRAS_API_KEY: "existing-test-value" },
        settingsOverlay,
      }),
    ).resolves.toMatchObject({ status: "already-configured" });
    expect(vault.has).not.toHaveBeenCalled();
    expect(vault.reveal).not.toHaveBeenCalled();
    expect(settingsOverlay).toEqual({});
  });

  it("fails closed when the canonical credential is unreadable", async () => {
    const vault = fakeVault({
      "providers.cerebras.api-key": "canonical-test-value",
      CEREBRAS_API_KEY: "legacy-test-value",
    });
    vault.reveal.mockRejectedValueOnce(new Error("test decrypt failure"));
    const settingsOverlay: Record<string, string> = {};

    await expect(
      hydrateSelectedProviderCredentialFromVault({
        providerId: "cerebras",
        vault,
        env: {},
        settingsOverlay,
      }),
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(vault.reveal).toHaveBeenCalledTimes(1);
    expect(settingsOverlay).toEqual({});
  });
});
