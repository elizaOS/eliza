import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateMasterKey } from "../src/crypto.js";
import { profileStorageKey, setEntryMeta } from "../src/inventory.js";
import { createManager } from "../src/manager.js";
import { inMemoryMasterKey } from "../src/master-key.js";
import {
  readRoutingConfig,
  resolveActiveValue,
  writeRoutingConfig,
} from "../src/profiles.js";
import { createVault, type Vault } from "../src/vault.js";

const KEY = "OPENROUTER_API_KEY";

describe("profiles — resolveActiveValue", () => {
  let workDir: string;
  let vault: Vault;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "eliza-profiles-"));
    vault = createVault({
      workDir,
      masterKey: inMemoryMasterKey(generateMasterKey()),
    });
  });
  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it("returns the bare key value when no meta exists (legacy path)", async () => {
    await vault.set(KEY, "sk-or-legacy", { sensitive: true });
    expect(await resolveActiveValue(vault, KEY)).toBe("sk-or-legacy");
  });

  it("returns the active profile's value when meta declares one", async () => {
    await vault.set(profileStorageKey(KEY, "default"), "sk-or-default", {
      sensitive: true,
    });
    await vault.set(profileStorageKey(KEY, "work"), "sk-or-work", {
      sensitive: true,
    });
    await vault.set(KEY, "sk-or-bare", { sensitive: true });
    await setEntryMeta(vault, KEY, {
      profiles: [
        { id: "default", label: "Default" },
        { id: "work", label: "Work" },
      ],
      activeProfile: "default",
    });
    expect(await resolveActiveValue(vault, KEY)).toBe("sk-or-default");

    await setEntryMeta(vault, KEY, { activeProfile: "work" });
    expect(await resolveActiveValue(vault, KEY)).toBe("sk-or-work");
  });

  it("falls back to the bare key when activeProfile points at a missing blob", async () => {
    await vault.set(KEY, "sk-or-bare", { sensitive: true });
    await setEntryMeta(vault, KEY, {
      profiles: [{ id: "phantom", label: "Phantom" }],
      activeProfile: "phantom",
      // The phantom profile blob was never written — fallback to bare key.
    });
    expect(await resolveActiveValue(vault, KEY)).toBe("sk-or-bare");
  });

  it("falls back to global defaultProfile when activeProfile is unset", async () => {
    await vault.set(profileStorageKey(KEY, "global"), "sk-or-global", {
      sensitive: true,
    });
    await vault.set(KEY, "sk-or-bare", { sensitive: true });
    await setEntryMeta(vault, KEY, {
      profiles: [{ id: "global", label: "Global" }],
      // no activeProfile
    });
    await writeRoutingConfig(vault, { rules: [], defaultProfile: "global" });
    expect(await resolveActiveValue(vault, KEY)).toBe("sk-or-global");
  });

  it("walks routing rules in order, first match wins", async () => {
    await vault.set(profileStorageKey(KEY, "work"), "sk-or-work", {
      sensitive: true,
    });
    await vault.set(profileStorageKey(KEY, "personal"), "sk-or-personal", {
      sensitive: true,
    });
    await setEntryMeta(vault, KEY, {
      profiles: [
        { id: "work", label: "Work" },
        { id: "personal", label: "Personal" },
      ],
      activeProfile: "work",
    });
    await writeRoutingConfig(vault, {
      rules: [
        {
          keyPattern: KEY,
          scope: { kind: "agent", agentId: "agent-A" },
          profileId: "personal",
        },
        {
          keyPattern: KEY,
          scope: { kind: "agent", agentId: "agent-A" },
          profileId: "work",
        },
      ],
    });

    expect(await resolveActiveValue(vault, KEY, { agentId: "agent-A" })).toBe(
      "sk-or-personal",
    );
    // Different agent → no rule matches → falls back to activeProfile.
    expect(await resolveActiveValue(vault, KEY, { agentId: "agent-B" })).toBe(
      "sk-or-work",
    );
  });

  it("matches scope by kind: agent / app / skill", async () => {
    await vault.set(profileStorageKey(KEY, "for-app"), "sk-app", {
      sensitive: true,
    });
    await vault.set(profileStorageKey(KEY, "for-skill"), "sk-skill", {
      sensitive: true,
    });
    await vault.set(profileStorageKey(KEY, "default"), "sk-default", {
      sensitive: true,
    });
    await setEntryMeta(vault, KEY, {
      profiles: [
        { id: "default", label: "Default" },
        { id: "for-app", label: "For App" },
        { id: "for-skill", label: "For Skill" },
      ],
      activeProfile: "default",
    });
    await writeRoutingConfig(vault, {
      rules: [
        {
          keyPattern: KEY,
          scope: { kind: "app", appName: "@elizaos/app-companion" },
          profileId: "for-app",
        },
        {
          keyPattern: KEY,
          scope: { kind: "skill", skillId: "code-review" },
          profileId: "for-skill",
        },
      ],
    });

    expect(
      await resolveActiveValue(vault, KEY, {
        appName: "@elizaos/app-companion",
      }),
    ).toBe("sk-app");
    expect(
      await resolveActiveValue(vault, KEY, { skillId: "code-review" }),
    ).toBe("sk-skill");
    expect(await resolveActiveValue(vault, KEY)).toBe("sk-default");
  });

  it("ignores rules that target a different keyPattern", async () => {
    await vault.set(profileStorageKey(KEY, "default"), "sk-default", {
      sensitive: true,
    });
    await setEntryMeta(vault, KEY, {
      profiles: [{ id: "default", label: "Default" }],
      activeProfile: "default",
    });
    await writeRoutingConfig(vault, {
      rules: [
        {
          keyPattern: "ANTHROPIC_API_KEY",
          scope: { kind: "agent", agentId: "agent-A" },
          profileId: "work",
        },
      ],
    });
    expect(await resolveActiveValue(vault, KEY, { agentId: "agent-A" })).toBe(
      "sk-default",
    );
  });

  it("ignores routing rules that name an unknown profile id", async () => {
    await vault.set(profileStorageKey(KEY, "default"), "sk-default", {
      sensitive: true,
    });
    await setEntryMeta(vault, KEY, {
      profiles: [{ id: "default", label: "Default" }],
      activeProfile: "default",
    });
    await writeRoutingConfig(vault, {
      rules: [
        {
          keyPattern: KEY,
          scope: { kind: "agent", agentId: "agent-A" },
          profileId: "ghost",
        },
      ],
    });
    expect(await resolveActiveValue(vault, KEY, { agentId: "agent-A" })).toBe(
      "sk-default",
    );
  });
});

describe("profiles — routing config persistence", () => {
  let workDir: string;
  let vault: Vault;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "eliza-routing-"));
    vault = createVault({
      workDir,
      masterKey: inMemoryMasterKey(generateMasterKey()),
    });
  });
  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it("returns empty config when no routing config has been written", async () => {
    expect(await readRoutingConfig(vault)).toEqual({ rules: [] });
  });

  it("round-trips a config", async () => {
    await writeRoutingConfig(vault, {
      rules: [
        {
          keyPattern: "OPENROUTER_API_KEY",
          scope: { kind: "agent", agentId: "abc" },
          profileId: "work",
        },
      ],
      defaultProfile: "default",
    });
    const got = await readRoutingConfig(vault);
    expect(got.rules).toHaveLength(1);
    expect(got.defaultProfile).toBe("default");
  });

  it("normalizes invalid rules out on write (drops bad entries silently)", async () => {
    await writeRoutingConfig(vault, {
      rules: [
        {
          keyPattern: "OPENROUTER_API_KEY",
          scope: { kind: "agent", agentId: "abc" },
          profileId: "work",
        },
        // Following entries are malformed and must be dropped:
        {
          // empty keyPattern
          keyPattern: "",
          scope: { kind: "agent", agentId: "abc" },
          profileId: "work",
        },
        {
          keyPattern: "X",
          // missing agentId on agent-scope
          scope: { kind: "agent" },
          profileId: "work",
        },
        {
          keyPattern: "X",
          scope: { kind: "agent", agentId: "abc" },
          profileId: "", // empty profileId
        },
        {
          keyPattern: "_meta.SECRET", // reserved key — not allowed
          scope: { kind: "agent", agentId: "abc" },
          profileId: "work",
        },
      ] as never,
    });
    const got = await readRoutingConfig(vault);
    expect(got.rules).toHaveLength(1);
  });
});

describe("profiles — manager.getActive integration", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "eliza-mgr-prof-"));
  });
  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it("getActive on a key without meta returns the bare value (matches get())", async () => {
    const vault = createVault({
      workDir,
      masterKey: inMemoryMasterKey(generateMasterKey()),
    });
    const m = createManager({ vault });
    await m.set(KEY, "sk-or-bare", { sensitive: true });
    expect(await m.getActive(KEY)).toBe("sk-or-bare");
    expect(await m.getActive(KEY)).toBe(await m.get(KEY));
  });

  it("getActive routes through the active profile when meta is present", async () => {
    const vault = createVault({
      workDir,
      masterKey: inMemoryMasterKey(generateMasterKey()),
    });
    const m = createManager({ vault });
    await vault.set(profileStorageKey(KEY, "work"), "sk-or-work", {
      sensitive: true,
    });
    await setEntryMeta(vault, KEY, {
      profiles: [{ id: "work", label: "Work" }],
      activeProfile: "work",
    });
    expect(await m.getActive(KEY)).toBe("sk-or-work");
  });
});
