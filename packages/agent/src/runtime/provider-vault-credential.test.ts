/**
 * Covers packaged-runtime provider credential hydration from protected Vault:
 * canonical/legacy selection, fail-closed reads, and no overwrite of an
 * already-projected environment credential. Deterministic; no real secrets.
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
  it("hydrates the selected provider from its canonical protected key", async () => {
    const env: NodeJS.ProcessEnv = {};
    const settingsOverlay: Record<string, string> = {};
    const vault = fakeVault({
      "providers.cerebras.api-key": "canonical-test-value",
      CEREBRAS_API_KEY: "legacy-test-value",
    });

    const result = await hydrateSelectedProviderCredentialFromVault({
      providerId: "cerebras",
      vault,
      env,
      settingsOverlay,
    });
    expect(result).toEqual({
      status: "hydrated",
      providerId: "cerebras",
      envKey: "CEREBRAS_API_KEY",
      vaultKey: "providers.cerebras.api-key",
    });
    expect(JSON.stringify(result)).not.toContain("canonical-test-value");
    expect(JSON.stringify(result)).not.toContain("legacy-test-value");
    expect(env.CEREBRAS_API_KEY).toBeUndefined();
    expect(settingsOverlay.CEREBRAS_API_KEY).toBe("canonical-test-value");
    expect(vault.reveal).toHaveBeenCalledWith(
      "providers.cerebras.api-key",
      "runtime-boot:selected-provider-credential",
    );
  });

  it("falls back to the legacy raw env key mirrored by vault bootstrap", async () => {
    const env: NodeJS.ProcessEnv = {};
    const settingsOverlay: Record<string, string> = {};
    const vault = fakeVault({ CEREBRAS_API_KEY: "legacy-test-value" });

    const result = await hydrateSelectedProviderCredentialFromVault({
      providerId: "cerebras",
      vault,
      env,
      settingsOverlay,
    });

    expect(result).toEqual({
      status: "hydrated",
      providerId: "cerebras",
      envKey: "CEREBRAS_API_KEY",
      vaultKey: "CEREBRAS_API_KEY",
    });
    expect(env.CEREBRAS_API_KEY).toBeUndefined();
    expect(settingsOverlay.CEREBRAS_API_KEY).toBe("legacy-test-value");
  });

  it("keeps an existing process credential and never reads Vault", async () => {
    const env: NodeJS.ProcessEnv = {
      CEREBRAS_API_KEY: "existing-test-value",
    };
    const vault = fakeVault({
      "providers.cerebras.api-key": "canonical-test-value",
    });
    const settingsOverlay: Record<string, string> = {};

    await expect(
      hydrateSelectedProviderCredentialFromVault({
        providerId: "cerebras",
        vault,
        env,
        settingsOverlay,
      }),
    ).resolves.toMatchObject({ status: "already-configured" });
    expect(env.CEREBRAS_API_KEY).toBe("existing-test-value");
    expect(vault.has).not.toHaveBeenCalled();
    expect(vault.reveal).not.toHaveBeenCalled();
    expect(settingsOverlay).toEqual({});
  });

  it("reports a missing selected credential without mutating the environment", async () => {
    const env: NodeJS.ProcessEnv = {};
    const settingsOverlay: Record<string, string> = {};
    const vault = fakeVault({});

    await expect(
      hydrateSelectedProviderCredentialFromVault({
        providerId: "cerebras",
        vault,
        env,
        settingsOverlay,
      }),
    ).resolves.toMatchObject({ status: "missing" });
    expect(env.CEREBRAS_API_KEY).toBeUndefined();
    expect(settingsOverlay).toEqual({});
  });

  it("is not applicable to a provider with no API-key env contract", async () => {
    const vault = fakeVault({});

    await expect(
      hydrateSelectedProviderCredentialFromVault({
        providerId: "ollama",
        vault,
        env: {},
        settingsOverlay: {},
      }),
    ).resolves.toEqual({ status: "not-applicable", providerId: "ollama" });
    expect(vault.has).not.toHaveBeenCalled();
  });

  it("fails closed when the canonical entry is unreadable and never tries legacy", async () => {
    const env: NodeJS.ProcessEnv = {};
    const settingsOverlay: Record<string, string> = {};
    const vault = fakeVault({
      "providers.cerebras.api-key": "canonical-test-value",
      CEREBRAS_API_KEY: "legacy-test-value",
    });
    vault.reveal.mockRejectedValueOnce(new Error("test decrypt failure"));

    await expect(
      hydrateSelectedProviderCredentialFromVault({
        providerId: "cerebras",
        vault,
        env,
        settingsOverlay,
      }),
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(env.CEREBRAS_API_KEY).toBeUndefined();
    expect(settingsOverlay).toEqual({});
    expect(vault.reveal).toHaveBeenCalledTimes(1);
    expect(vault.reveal).not.toHaveBeenCalledWith(
      "CEREBRAS_API_KEY",
      expect.anything(),
    );
  });

  it("reports Vault inventory failures without revealing a credential", async () => {
    const env: NodeJS.ProcessEnv = {};
    const settingsOverlay: Record<string, string> = {};
    const vault = fakeVault({});
    vault.has.mockRejectedValueOnce(new Error("test inventory failure"));

    await expect(
      hydrateSelectedProviderCredentialFromVault({
        providerId: "cerebras",
        vault,
        env,
        settingsOverlay,
      }),
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(env.CEREBRAS_API_KEY).toBeUndefined();
    expect(settingsOverlay).toEqual({});
    expect(vault.reveal).not.toHaveBeenCalled();
  });
});
