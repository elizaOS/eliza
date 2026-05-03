import {
  profileStorageKey,
  setEntryMeta,
  writeRoutingConfig,
} from "@elizaos/vault";
import { createTestVault, type TestVault } from "@elizaos/vault/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyVaultProfilesForAgent } from "./vault-profile-resolver.js";

describe("vault-profile-resolver", () => {
  let testVault: TestVault;
  // Save and restore process.env between tests so we don't bleed state.
  const SCRATCH_KEY = "OPENROUTER_API_KEY";
  const previousEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    testVault = await createTestVault();
    previousEnv[SCRATCH_KEY] = process.env[SCRATCH_KEY];
    delete process.env[SCRATCH_KEY];
    delete process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER;
  });
  afterEach(async () => {
    await testVault.dispose();
    if (previousEnv[SCRATCH_KEY] === undefined) {
      delete process.env[SCRATCH_KEY];
    } else {
      process.env[SCRATCH_KEY] = previousEnv[SCRATCH_KEY];
    }
  });

  it("does nothing when no profiles are configured (legacy keys preserved)", async () => {
    await testVault.vault.set(SCRATCH_KEY, "sk-or-bare", { sensitive: true });
    const before = process.env[SCRATCH_KEY];
    const result = await applyVaultProfilesForAgent(testVault.vault, "agent-A");
    expect(result.overridden).toBe(0);
    // process.env stays untouched (undefined → undefined).
    expect(process.env[SCRATCH_KEY]).toBe(before);
  });

  it("writes the active profile value to process.env when profiles are configured", async () => {
    await testVault.vault.set(
      profileStorageKey(SCRATCH_KEY, "default"),
      "sk-default",
      {
        sensitive: true,
      },
    );
    await testVault.vault.set(
      profileStorageKey(SCRATCH_KEY, "work"),
      "sk-work",
      {
        sensitive: true,
      },
    );
    await setEntryMeta(testVault.vault, SCRATCH_KEY, {
      profiles: [
        { id: "default", label: "Default" },
        { id: "work", label: "Work" },
      ],
      activeProfile: "default",
    });

    const result = await applyVaultProfilesForAgent(testVault.vault, "agent-A");
    expect(result.overridden).toBe(1);
    expect(process.env[SCRATCH_KEY]).toBe("sk-default");
  });

  it("respects per-agent routing rules (different agents → different profiles)", async () => {
    await testVault.vault.set(
      profileStorageKey(SCRATCH_KEY, "work"),
      "sk-work",
      {
        sensitive: true,
      },
    );
    await testVault.vault.set(
      profileStorageKey(SCRATCH_KEY, "personal"),
      "sk-personal",
      {
        sensitive: true,
      },
    );
    await setEntryMeta(testVault.vault, SCRATCH_KEY, {
      profiles: [
        { id: "work", label: "Work" },
        { id: "personal", label: "Personal" },
      ],
      activeProfile: "work",
    });
    await writeRoutingConfig(testVault.vault, {
      rules: [
        {
          keyPattern: SCRATCH_KEY,
          scope: { kind: "agent", agentId: "agent-personal" },
          profileId: "personal",
        },
      ],
    });

    await applyVaultProfilesForAgent(testVault.vault, "agent-personal");
    expect(process.env[SCRATCH_KEY]).toBe("sk-personal");

    // Re-running for a different agent flips the env value.
    await applyVaultProfilesForAgent(testVault.vault, "agent-other");
    expect(process.env[SCRATCH_KEY]).toBe("sk-work");
  });

  it("opt-out via ELIZA_DISABLE_VAULT_PROFILE_RESOLVER=1", async () => {
    await testVault.vault.set(
      profileStorageKey(SCRATCH_KEY, "default"),
      "sk-default",
      {
        sensitive: true,
      },
    );
    await setEntryMeta(testVault.vault, SCRATCH_KEY, {
      profiles: [{ id: "default", label: "Default" }],
      activeProfile: "default",
    });
    process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER = "1";
    const result = await applyVaultProfilesForAgent(testVault.vault, "agent-A");
    expect(result.overridden).toBe(0);
    expect(process.env[SCRATCH_KEY]).toBeUndefined();
    delete process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER;
  });

  it("reports failed when the active profile blob is missing AND no bare value", async () => {
    // Profiles declared but no profile blob and no bare key — resolveActiveValue
    // throws VaultMiss; we record it as `failed` so the operator sees it.
    await setEntryMeta(testVault.vault, SCRATCH_KEY, {
      profiles: [{ id: "default", label: "Default" }],
      activeProfile: "default",
    });
    const result = await applyVaultProfilesForAgent(testVault.vault, "agent-A");
    expect(result.failed).toContain(SCRATCH_KEY);
    expect(result.overridden).toBe(0);
    expect(process.env[SCRATCH_KEY]).toBeUndefined();
  });
});
