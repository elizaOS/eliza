/**
 * Deterministic coverage for packaged provider hydration from protected Vault.
 * No real credential, provider request, or process environment mutation occurs.
 */

import { isElizaError } from "@elizaos/core";
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

  it("treats a genuinely absent credential as the expected missing state", async () => {
    const settingsOverlay: Record<string, string> = {};

    await expect(
      hydrateSelectedProviderCredentialFromVault({
        providerId: "cerebras",
        vault: fakeVault({}),
        env: {},
        settingsOverlay,
      }),
    ).resolves.toEqual({
      status: "missing",
      providerId: "cerebras",
      envKey: "CEREBRAS_API_KEY",
    });
    expect(settingsOverlay).toEqual({});
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

  it("fails boot input resolution with the reveal cause when the canonical credential is unreadable", async () => {
    const vault = fakeVault({
      "providers.cerebras.api-key": "canonical-test-value",
      CEREBRAS_API_KEY: "legacy-test-value",
    });
    const cause = new Error("test decrypt failure");
    vault.reveal.mockRejectedValueOnce(cause);
    const settingsOverlay: Record<string, string> = {};

    try {
      await hydrateSelectedProviderCredentialFromVault({
        providerId: "cerebras",
        vault,
        env: {},
        settingsOverlay,
      });
      expect.unreachable("unreadable selected credential must reject boot");
    } catch (error) {
      expect(isElizaError(error)).toBe(true);
      if (isElizaError(error)) {
        expect(error).toMatchObject({
          code: "SELECTED_PROVIDER_CREDENTIAL_UNAVAILABLE",
          severity: "fatal",
          context: {
            providerId: "cerebras",
            envKey: "CEREBRAS_API_KEY",
            stage: "reveal",
            vaultKey: "providers.cerebras.api-key",
          },
          cause,
        });
      }
    }
    expect(vault.reveal).toHaveBeenCalledTimes(1);
    expect(settingsOverlay).toEqual({});
  });

  it("fails boot input resolution with the storage cause when Vault lookup is unavailable", async () => {
    const cause = new Error("test vault database unavailable");
    const vault = fakeVault({});
    vault.has.mockRejectedValueOnce(cause);

    await expect(
      hydrateSelectedProviderCredentialFromVault({
        providerId: "cerebras",
        vault,
        env: {},
        settingsOverlay: {},
      }),
    ).rejects.toMatchObject({
      code: "SELECTED_PROVIDER_CREDENTIAL_UNAVAILABLE",
      severity: "fatal",
      context: {
        providerId: "cerebras",
        envKey: "CEREBRAS_API_KEY",
        stage: "lookup",
      },
      cause,
    });
    expect(vault.reveal).not.toHaveBeenCalled();
  });
});
