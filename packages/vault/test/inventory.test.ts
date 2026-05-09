import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateMasterKey } from "../src/crypto.js";
import {
  categorizeKey,
  inferProviderId,
  listVaultInventory,
  profileStorageKey,
  readEntryMeta,
  removeEntryMeta,
  setEntryMeta,
} from "../src/inventory.js";
import { inMemoryMasterKey } from "../src/master-key.js";
import { createVault, type Vault } from "../src/vault.js";

describe("inventory — categorization heuristics", () => {
  it("classifies provider env-var API keys", () => {
    expect(categorizeKey("OPENAI_API_KEY")).toBe("provider");
    expect(categorizeKey("ANTHROPIC_API_KEY")).toBe("provider");
    expect(categorizeKey("OPENROUTER_API_KEY")).toBe("provider");
    expect(categorizeKey("GROQ_API_KEY")).toBe("provider");
    expect(categorizeKey("GOOGLE_GENERATIVE_AI_API_KEY")).toBe("provider");
    expect(categorizeKey("GEMINI_API_KEY")).toBe("provider");
    expect(categorizeKey("PERPLEXITY_API_KEY")).toBe("provider");
  });

  it("classifies generic _API_KEY suffixes as plugin", () => {
    expect(categorizeKey("WORKFLOW_API_KEY")).toBe("plugin");
    expect(categorizeKey("CUSTOM_BACKEND_API_KEY")).toBe("plugin");
  });

  it("classifies wallet keys", () => {
    expect(categorizeKey("EVM_PRIVATE_KEY")).toBe("wallet");
    expect(categorizeKey("SOLANA_PRIVATE_KEY")).toBe("wallet");
    expect(categorizeKey("MY_MNEMONIC")).toBe("wallet");
    expect(categorizeKey("BACKUP_SEED_PHRASE")).toBe("wallet");
    // Phase 3 unified storage shape
    expect(categorizeKey("wallet.dizzy.evm.privateKey")).toBe("wallet");
    expect(categorizeKey("wallet.casper.solana.privateKey")).toBe("wallet");
    // Legacy per-agent shape
    expect(categorizeKey("agent.dizzy.wallet.evm")).toBe("wallet");
    expect(categorizeKey("agent.casper.wallet.solana")).toBe("wallet");
  });

  it("classifies saved-login records as credential", () => {
    expect(categorizeKey("creds.github.com.alice")).toBe("credential");
  });

  it("classifies password-manager session tokens", () => {
    expect(categorizeKey("pm.1password.session")).toBe("session");
    expect(categorizeKey("pm.bitwarden.session")).toBe("session");
  });

  it("classifies internal manager keys + routing config as system", () => {
    expect(categorizeKey("_manager.preferences")).toBe("system");
    expect(categorizeKey("_routing.config")).toBe("system");
  });

  it("falls back to plugin for unknown keys without a recognized pattern", () => {
    expect(categorizeKey("ELIZA_SCREENSHOT_SERVER_TOKEN")).toBe("plugin");
    expect(categorizeKey("GITHUB_TOKEN")).toBe("plugin");
  });
});

describe("inventory — provider id inference", () => {
  it("derives ids from canonical env-var names", () => {
    expect(inferProviderId("OPENAI_API_KEY")).toBe("openai");
    expect(inferProviderId("ANTHROPIC_API_KEY")).toBe("anthropic");
    expect(inferProviderId("OPENROUTER_API_KEY")).toBe("openrouter");
    expect(inferProviderId("XAI_API_KEY")).toBe("grok");
    expect(inferProviderId("GOOGLE_GENERATIVE_AI_API_KEY")).toBe("gemini");
  });

  it("falls back to lowercased prefix for unknown _API_KEY suffixes", () => {
    expect(inferProviderId("FOO_BAR_API_KEY")).toBe("foo_bar");
  });

  it("returns null for non-API-key keys", () => {
    expect(inferProviderId("EVM_PRIVATE_KEY")).toBe(null);
    expect(inferProviderId("creds.github.com.alice")).toBe(null);
  });
});

describe("inventory — meta read/write", () => {
  let workDir: string;
  let vault: Vault;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "eliza-inv-meta-"));
    vault = createVault({
      workDir,
      masterKey: inMemoryMasterKey(generateMasterKey()),
    });
  });
  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it("returns null when no meta has been written", async () => {
    expect(await readEntryMeta(vault, "OPENROUTER_API_KEY")).toBe(null);
  });

  it("merges partial writes (read-modify-write semantics)", async () => {
    await setEntryMeta(vault, "OPENROUTER_API_KEY", {
      label: "OpenRouter",
      providerId: "openrouter",
      category: "provider",
    });
    await setEntryMeta(vault, "OPENROUTER_API_KEY", {
      activeProfile: "work",
    });
    const meta = await readEntryMeta(vault, "OPENROUTER_API_KEY");
    expect(meta?.label).toBe("OpenRouter");
    expect(meta?.providerId).toBe("openrouter");
    expect(meta?.activeProfile).toBe("work");
  });

  it("treats null as a delete signal", async () => {
    await setEntryMeta(vault, "OPENROUTER_API_KEY", {
      activeProfile: "work",
    });
    await setEntryMeta(vault, "OPENROUTER_API_KEY", {
      activeProfile: null,
    });
    const meta = await readEntryMeta(vault, "OPENROUTER_API_KEY");
    expect(meta?.activeProfile).toBeUndefined();
  });

  it("removeEntryMeta drops the meta blob without touching the value", async () => {
    await vault.set("OPENROUTER_API_KEY", "sk-or-v1", { sensitive: true });
    await setEntryMeta(vault, "OPENROUTER_API_KEY", {
      label: "OpenRouter",
      category: "provider",
    });
    await removeEntryMeta(vault, "OPENROUTER_API_KEY");
    expect(await readEntryMeta(vault, "OPENROUTER_API_KEY")).toBe(null);
    // Underlying value still present.
    expect(await vault.get("OPENROUTER_API_KEY")).toBe("sk-or-v1");
  });

  it("rejects malformed JSON instead of silently returning empty meta", async () => {
    await vault.set("_meta.OPENROUTER_API_KEY", "not-json");
    await expect(readEntryMeta(vault, "OPENROUTER_API_KEY")).rejects.toThrow();
  });

  it("rejects non-object JSON", async () => {
    await vault.set("_meta.OPENROUTER_API_KEY", JSON.stringify(["not-object"]));
    await expect(readEntryMeta(vault, "OPENROUTER_API_KEY")).rejects.toThrow();
  });

  it("filters invalid profile entries on read", async () => {
    await vault.set(
      "_meta.OPENROUTER_API_KEY",
      JSON.stringify({
        profiles: [
          { id: "default", label: "Default" },
          { label: "no id" }, // missing id — drop
          { id: "" }, // empty id — drop
          "not-an-object", // wrong type — drop
          { id: "work" }, // missing label — keep, label defaults to id
        ],
      }),
    );
    const meta = await readEntryMeta(vault, "OPENROUTER_API_KEY");
    expect(meta?.profiles).toHaveLength(2);
    expect(meta?.profiles?.[0]).toMatchObject({
      id: "default",
      label: "Default",
    });
    expect(meta?.profiles?.[1]).toMatchObject({ id: "work", label: "work" });
  });
});

describe("inventory — listVaultInventory", () => {
  let workDir: string;
  let vault: Vault;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "eliza-inv-list-"));
    vault = createVault({
      workDir,
      masterKey: inMemoryMasterKey(generateMasterKey()),
    });
  });
  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it("groups every stored key by inferred category, never reveals values", async () => {
    // Use distinctive value markers that don't collide with key names.
    await vault.set("OPENROUTER_API_KEY", "sk-or-XXXX-NEVERLEAK-1", {
      sensitive: true,
    });
    await vault.set("EVM_PRIVATE_KEY", "0xNEVERLEAK2", { sensitive: true });
    await vault.set("WORKFLOW_API_KEY", "workflow-NEVERLEAK-3", {
      sensitive: true,
    });
    await vault.set("creds.github.com.alice", "PASSWORD-NEVERLEAK-4", {
      sensitive: true,
    });
    await vault.set("pm.1password.session", "SESSION-NEVERLEAK-5", {
      sensitive: true,
    });

    const inv = await listVaultInventory(vault);
    const byKey = new Map(inv.map((e) => [e.key, e]));
    expect(byKey.get("OPENROUTER_API_KEY")?.category).toBe("provider");
    expect(byKey.get("EVM_PRIVATE_KEY")?.category).toBe("wallet");
    expect(byKey.get("WORKFLOW_API_KEY")?.category).toBe("plugin");
    expect(byKey.get("creds.github.com.alice")?.category).toBe("credential");
    expect(byKey.get("pm.1password.session")?.category).toBe("session");

    // Hard rule: list output never carries the underlying value.
    const text = JSON.stringify(inv);
    expect(text).not.toContain("NEVERLEAK");
  });

  it("filters reserved prefixes (_meta, _routing, _manager) out of the list", async () => {
    await vault.set("OPENROUTER_API_KEY", "sk-or", { sensitive: true });
    await setEntryMeta(vault, "OPENROUTER_API_KEY", {
      label: "OpenRouter",
      category: "provider",
    });
    await vault.set("_routing.config", JSON.stringify({ rules: [] }));
    await vault.set(
      "_manager.preferences",
      JSON.stringify({ enabled: ["in-house"] }),
    );

    const inv = await listVaultInventory(vault);
    expect(inv.find((e) => e.key.startsWith("_meta."))).toBeUndefined();
    expect(inv.find((e) => e.key === "_routing.config")).toBeUndefined();
    expect(inv.find((e) => e.key === "_manager.preferences")).toBeUndefined();
    expect(inv.find((e) => e.key === "OPENROUTER_API_KEY")).toBeDefined();
  });

  it("rolls profile children up under the parent key", async () => {
    // Simulate a key with two profiles. The bare key may or may not
    // exist; what matters is that listing surfaces only the parent.
    await vault.set("OPENROUTER_API_KEY", "sk-or-default", { sensitive: true });
    await vault.set(
      profileStorageKey("OPENROUTER_API_KEY", "default"),
      "sk-or-default",
      { sensitive: true },
    );
    await vault.set(
      profileStorageKey("OPENROUTER_API_KEY", "work"),
      "sk-or-work",
      { sensitive: true },
    );
    await setEntryMeta(vault, "OPENROUTER_API_KEY", {
      profiles: [
        { id: "default", label: "Default" },
        { id: "work", label: "Work" },
      ],
      activeProfile: "default",
      category: "provider",
      label: "OpenRouter",
    });

    const inv = await listVaultInventory(vault);
    const matching = inv.filter((e) => e.key.startsWith("OPENROUTER_API_KEY"));
    expect(matching).toHaveLength(1);
    expect(matching[0]?.hasProfiles).toBe(true);
    expect(matching[0]?.profiles).toHaveLength(2);
    expect(matching[0]?.activeProfile).toBe("default");
  });

  it("uses meta.category override when present (not heuristic)", async () => {
    await vault.set("RANDOM_TOKEN", "v", { sensitive: true });
    // Heuristic would say "plugin"; the meta override forces "provider".
    await setEntryMeta(vault, "RANDOM_TOKEN", { category: "provider" });
    const inv = await listVaultInventory(vault);
    expect(inv.find((e) => e.key === "RANDOM_TOKEN")?.category).toBe(
      "provider",
    );
  });

  it("reports kind faithfully for value/secret/reference entries", async () => {
    await vault.set("UI_THEME", "dark"); // value
    await vault.set("OPENROUTER_API_KEY", "sk-or", { sensitive: true }); // secret
    await vault.setReference("MY_REF", { source: "1password", path: "a/b" });
    const inv = await listVaultInventory(vault);
    expect(inv.find((e) => e.key === "UI_THEME")?.kind).toBe("value");
    expect(inv.find((e) => e.key === "OPENROUTER_API_KEY")?.kind).toBe(
      "secret",
    );
    expect(inv.find((e) => e.key === "MY_REF")?.kind).toBe("reference");
  });
});

describe("profileStorageKey", () => {
  it("produces dot-segment safe keys", () => {
    expect(profileStorageKey("OPENROUTER_API_KEY", "default")).toBe(
      "OPENROUTER_API_KEY.profile.default",
    );
    expect(profileStorageKey("OPENROUTER_API_KEY", "work_2")).toBe(
      "OPENROUTER_API_KEY.profile.work_2",
    );
  });

  it("rejects empty profile id", () => {
    expect(() => profileStorageKey("K", "")).toThrow(TypeError);
  });

  it("rejects non-pattern profile id (no whitespace, no dots, no slashes)", () => {
    expect(() => profileStorageKey("K", "with space")).toThrow(TypeError);
    expect(() => profileStorageKey("K", "with.dot")).toThrow(TypeError);
    expect(() => profileStorageKey("K", "with/slash")).toThrow(TypeError);
  });
});
