/**
 * Behavioral coverage for boot-time vault profile resolution.
 * Drives the real module against `createTestVault`: opt-out, empty inventory,
 * unprofiled keys, agent routing (first-match wins; app/skill rules ignored),
 * skipped empty values, password-manager references, missing-profile failures,
 * mixed queues, and idempotent re-application. Collaborators are real vault
 * APIs; process.env is snapshotted and restored.
 */
import {
  createTestVault,
  profileStorageKey,
  setEntryMeta,
  type TestVault,
  type Vault,
  writeRoutingConfig,
} from "@elizaos/vault";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyVaultProfilesForAgent } from "./vault-profile-resolver.ts";

const AGENT_ID = "vault-profile-resolver-agent";
const OTHER_AGENT_ID = "vault-profile-resolver-other";

const KEY_WORK = "VPR_TEST_WORK_API_KEY";
const KEY_PERSONAL = "VPR_TEST_PERSONAL_API_KEY";
const KEY_EMPTY = "VPR_TEST_EMPTY_API_KEY";
const KEY_FAIL = "VPR_TEST_FAIL_API_KEY";
const KEY_LEGACY = "VPR_TEST_LEGACY_API_KEY";
const KEY_REF = "VPR_TEST_REF_API_KEY";
const KEY_WS = "VPR_TEST_WS_API_KEY";
const KEY_MALFORMED = "VPR_TEST_MALFORMED_API_KEY";

const DISABLE = "ELIZA_DISABLE_VAULT_PROFILE_RESOLVER";

const ENV_KEYS = [
  DISABLE,
  KEY_WORK,
  KEY_PERSONAL,
  KEY_EMPTY,
  KEY_FAIL,
  KEY_LEGACY,
  KEY_REF,
  KEY_WS,
  KEY_MALFORMED,
] as const;

function restoreEnv(
  snapshot: Record<(typeof ENV_KEYS)[number], string | undefined>,
): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function seedProfiledKey(
  vault: Vault,
  key: string,
  profiles: Readonly<Record<string, string>>,
  activeProfile: string,
): Promise<void> {
  for (const [id, value] of Object.entries(profiles)) {
    await vault.set(profileStorageKey(key, id), value, { sensitive: true });
  }
  await setEntryMeta(vault, key, {
    profiles: Object.keys(profiles).map((id) => ({ id, label: id })),
    activeProfile,
  });
}

describe("applyVaultProfilesForAgent", () => {
  let test: TestVault;
  let envSnapshot: Record<(typeof ENV_KEYS)[number], string | undefined>;

  beforeEach(async () => {
    envSnapshot = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    ) as Record<(typeof ENV_KEYS)[number], string | undefined>;
    for (const key of ENV_KEYS) delete process.env[key];
    test = await createTestVault();
  });

  afterEach(async () => {
    restoreEnv(envSnapshot);
    await test.dispose();
  });

  it("returns an empty result when the vault inventory is empty", async () => {
    const result = await applyVaultProfilesForAgent(test.vault, AGENT_ID);

    expect(result).toEqual({ overridden: 0, skipped: [], failed: [] });
    expect(Object.isFrozen(result.skipped)).toBe(true);
    expect(Object.isFrozen(result.failed)).toBe(true);
    expect(process.env[KEY_WORK]).toBeUndefined();
  });

  it("leaves keys without profiles alone, including a pre-seeded process.env value", async () => {
    process.env[KEY_LEGACY] = "env-legacy";
    await test.vault.set(KEY_LEGACY, "vault-legacy", { sensitive: true });

    const result = await applyVaultProfilesForAgent(test.vault, AGENT_ID);

    expect(result).toEqual({ overridden: 0, skipped: [], failed: [] });
    expect(process.env[KEY_LEGACY]).toBe("env-legacy");
  });

  it("overrides process.env with the active profile for a single profiled key", async () => {
    process.env[KEY_WORK] = "stale-env";
    await seedProfiledKey(
      test.vault,
      KEY_WORK,
      { work: "sk-work", personal: "sk-personal" },
      "work",
    );

    const result = await applyVaultProfilesForAgent(test.vault, AGENT_ID);

    expect(result.overridden).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(process.env[KEY_WORK]).toBe("sk-work");
  });

  it("is idempotent: a second apply writes the same env value and recounts the override", async () => {
    await seedProfiledKey(test.vault, KEY_WORK, { work: "sk-work" }, "work");

    const first = await applyVaultProfilesForAgent(test.vault, AGENT_ID);
    const second = await applyVaultProfilesForAgent(test.vault, AGENT_ID);

    expect(first).toEqual({ overridden: 1, skipped: [], failed: [] });
    expect(second).toEqual({ overridden: 1, skipped: [], failed: [] });
    expect(process.env[KEY_WORK]).toBe("sk-work");
  });

  it("opts out entirely when ELIZA_DISABLE_VAULT_PROFILE_RESOLVER is the string 1", async () => {
    process.env[DISABLE] = "1";
    await seedProfiledKey(test.vault, KEY_WORK, { work: "sk-work" }, "work");

    const result = await applyVaultProfilesForAgent(test.vault, AGENT_ID);

    expect(result).toEqual({ overridden: 0, skipped: [], failed: [] });
    expect(process.env[KEY_WORK]).toBeUndefined();
  });

  it("still resolves when the disable flag is set to a value other than 1", async () => {
    process.env[DISABLE] = "true";
    await seedProfiledKey(test.vault, KEY_WORK, { work: "sk-work" }, "work");

    const result = await applyVaultProfilesForAgent(test.vault, AGENT_ID);

    expect(result.overridden).toBe(1);
    expect(process.env[KEY_WORK]).toBe("sk-work");
  });

  it("applies the first matching agent routing rule and ignores later ties", async () => {
    await seedProfiledKey(
      test.vault,
      KEY_WORK,
      { work: "sk-work", personal: "sk-personal" },
      "work",
    );
    await writeRoutingConfig(test.vault, {
      rules: [
        {
          keyPattern: KEY_WORK,
          scope: { kind: "agent", agentId: AGENT_ID },
          profileId: "personal",
        },
        {
          keyPattern: KEY_WORK,
          scope: { kind: "agent", agentId: AGENT_ID },
          profileId: "work",
        },
      ],
    });

    const result = await applyVaultProfilesForAgent(test.vault, AGENT_ID);

    expect(result.overridden).toBe(1);
    expect(process.env[KEY_WORK]).toBe("sk-personal");
  });

  it("does not apply an agent rule written for a different agentId", async () => {
    await seedProfiledKey(
      test.vault,
      KEY_WORK,
      { work: "sk-work", personal: "sk-personal" },
      "work",
    );
    await writeRoutingConfig(test.vault, {
      rules: [
        {
          keyPattern: KEY_WORK,
          scope: { kind: "agent", agentId: OTHER_AGENT_ID },
          profileId: "personal",
        },
      ],
    });

    const result = await applyVaultProfilesForAgent(test.vault, AGENT_ID);

    expect(result.overridden).toBe(1);
    expect(process.env[KEY_WORK]).toBe("sk-work");
  });

  it("ignores app and skill routing rules because the resolver only supplies agentId", async () => {
    await seedProfiledKey(
      test.vault,
      KEY_WORK,
      { work: "sk-work", forApp: "sk-app", forSkill: "sk-skill" },
      "work",
    );
    await writeRoutingConfig(test.vault, {
      rules: [
        {
          keyPattern: KEY_WORK,
          scope: { kind: "app", appName: "@elizaos/plugin-feed" },
          profileId: "forApp",
        },
        {
          keyPattern: KEY_WORK,
          scope: { kind: "skill", skillId: "code-review" },
          profileId: "forSkill",
        },
      ],
    });

    const result = await applyVaultProfilesForAgent(test.vault, AGENT_ID);

    expect(result.overridden).toBe(1);
    expect(process.env[KEY_WORK]).toBe("sk-work");
  });

  it("skips a profiled key whose resolved value is empty and records the key", async () => {
    await seedProfiledKey(test.vault, KEY_EMPTY, { empty: "" }, "empty");

    const result = await applyVaultProfilesForAgent(test.vault, AGENT_ID);

    expect(result.overridden).toBe(0);
    expect(result.skipped).toEqual([KEY_EMPTY]);
    expect(result.failed).toEqual([]);
    expect(process.env[KEY_EMPTY]).toBeUndefined();
  });

  it("overrides with a whitespace-only profile because the live check is length, not trim", async () => {
    await seedProfiledKey(test.vault, KEY_WS, { ws: "   " }, "ws");

    const result = await applyVaultProfilesForAgent(test.vault, AGENT_ID);

    expect(result.overridden).toBe(1);
    expect(process.env[KEY_WS]).toBe("   ");
  });

  it("records a failed key when profiles are declared but no profile blob or bare value exists", async () => {
    await setEntryMeta(test.vault, KEY_FAIL, {
      profiles: [{ id: "ghost", label: "Ghost" }],
      activeProfile: "ghost",
    });

    const result = await applyVaultProfilesForAgent(test.vault, AGENT_ID);

    expect(result.overridden).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([KEY_FAIL]);
    expect(process.env[KEY_FAIL]).toBeUndefined();
  });

  it("falls back to the bare key when the active profile blob is missing", async () => {
    await test.vault.set(KEY_WORK, "sk-bare", { sensitive: true });
    await setEntryMeta(test.vault, KEY_WORK, {
      profiles: [{ id: "phantom", label: "Phantom" }],
      activeProfile: "phantom",
    });

    const result = await applyVaultProfilesForAgent(test.vault, AGENT_ID);

    expect(result.overridden).toBe(1);
    expect(process.env[KEY_WORK]).toBe("sk-bare");
  });

  it("skips password-manager reference entries even when they declare profiles", async () => {
    await test.vault.setReference(KEY_REF, {
      source: "1password",
      path: "op://vault/item/credential",
    });
    await test.vault.set(profileStorageKey(KEY_REF, "default"), "sk-ref", {
      sensitive: true,
    });
    await setEntryMeta(test.vault, KEY_REF, {
      profiles: [{ id: "default", label: "Default" }],
      activeProfile: "default",
    });

    const result = await applyVaultProfilesForAgent(test.vault, AGENT_ID);

    expect(result.overridden).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(process.env[KEY_REF]).toBeUndefined();
  });

  it("returns empty and writes no env when inventory listing fails on malformed meta JSON", async () => {
    await seedProfiledKey(test.vault, KEY_WORK, { work: "sk-work" }, "work");
    await test.vault.set(`_meta.${KEY_MALFORMED}`, "not-json");

    const result = await applyVaultProfilesForAgent(test.vault, AGENT_ID);

    expect(result).toEqual({ overridden: 0, skipped: [], failed: [] });
    expect(process.env[KEY_WORK]).toBeUndefined();
  });

  it("walks a mixed inventory: override, skip empty, fail missing, leave unprofiled and references", async () => {
    process.env[KEY_LEGACY] = "env-legacy";
    await seedProfiledKey(test.vault, KEY_WORK, { work: "sk-work" }, "work");
    await seedProfiledKey(test.vault, KEY_EMPTY, { empty: "" }, "empty");
    await setEntryMeta(test.vault, KEY_FAIL, {
      profiles: [{ id: "ghost", label: "Ghost" }],
      activeProfile: "ghost",
    });
    await test.vault.set(KEY_LEGACY, "vault-legacy", { sensitive: true });
    await test.vault.setReference(KEY_REF, {
      source: "protonpass",
      path: "proton://item",
    });
    await setEntryMeta(test.vault, KEY_REF, {
      profiles: [{ id: "default", label: "Default" }],
      activeProfile: "default",
    });

    const result = await applyVaultProfilesForAgent(test.vault, AGENT_ID);

    expect(result.overridden).toBe(1);
    expect(result.skipped).toEqual([KEY_EMPTY]);
    expect(result.failed).toEqual([KEY_FAIL]);
    expect(Object.isFrozen(result.skipped)).toBe(true);
    expect(Object.isFrozen(result.failed)).toBe(true);
    expect(process.env[KEY_WORK]).toBe("sk-work");
    expect(process.env[KEY_EMPTY]).toBeUndefined();
    expect(process.env[KEY_FAIL]).toBeUndefined();
    expect(process.env[KEY_LEGACY]).toBe("env-legacy");
    expect(process.env[KEY_REF]).toBeUndefined();
  });

  it("continues after a failed key so a later profiled key still overrides", async () => {
    await setEntryMeta(test.vault, KEY_FAIL, {
      profiles: [{ id: "ghost", label: "Ghost" }],
      activeProfile: "ghost",
    });
    await seedProfiledKey(
      test.vault,
      KEY_PERSONAL,
      { personal: "sk-personal" },
      "personal",
    );

    const result = await applyVaultProfilesForAgent(test.vault, AGENT_ID);

    expect(result.failed).toContain(KEY_FAIL);
    expect(result.overridden).toBe(1);
    expect(process.env[KEY_PERSONAL]).toBe("sk-personal");
  });
});
