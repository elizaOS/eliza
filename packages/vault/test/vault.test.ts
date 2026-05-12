import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestVault, type TestVault } from "../src/testing.js";
import { VaultMissError } from "../src/vault.js";

describe("vault — set / get / has / remove", () => {
  let test: TestVault;

  beforeEach(async () => {
    test = await createTestVault();
  });
  afterEach(async () => {
    await test.dispose();
  });

  it("stores and retrieves a non-sensitive value", async () => {
    await test.vault.set("ui.theme", "dark");
    expect(await test.vault.get("ui.theme")).toBe("dark");
  });

  it("stores and retrieves a sensitive value (encrypted at rest)", async () => {
    await test.vault.set("openrouter.apiKey", "sk-or-v1-test", {
      sensitive: true,
    });
    expect(await test.vault.get("openrouter.apiKey")).toBe("sk-or-v1-test");

    // The plaintext value must NOT appear in the file.
    const raw = await fs.readFile(test.storePath, "utf8");
    expect(raw).not.toContain("sk-or-v1-test");
  });

  it("non-sensitive values DO appear plainly in the file (by design)", async () => {
    await test.vault.set("ui.theme", "dark");
    const raw = await fs.readFile(test.storePath, "utf8");
    expect(raw).toContain("dark");
  });

  it("has() reports presence without revealing value", async () => {
    expect(await test.vault.has("openrouter.apiKey")).toBe(false);
    await test.vault.set("openrouter.apiKey", "v", { sensitive: true });
    expect(await test.vault.has("openrouter.apiKey")).toBe(true);
  });

  it("get() throws VaultMissError for missing keys", async () => {
    await expect(test.vault.get("nonexistent")).rejects.toThrow(VaultMissError);
  });

  it("remove() deletes the entry", async () => {
    await test.vault.set("ui.theme", "dark");
    await test.vault.remove("ui.theme");
    expect(await test.vault.has("ui.theme")).toBe(false);
  });

  it("remove() is idempotent", async () => {
    await expect(test.vault.remove("never-existed")).resolves.toBeUndefined();
  });

  it("rejects empty / non-string keys", async () => {
    await expect(test.vault.set("", "v")).rejects.toThrow();
    await expect(
      // @ts-expect-error exercises runtime validation for invalid callers.
      test.vault.set(123, "v"),
    ).rejects.toThrow();
  });

  it("rejects non-string values", async () => {
    await expect(
      // @ts-expect-error exercises runtime validation for invalid callers.
      test.vault.set("k", 42),
    ).rejects.toThrow();
  });
});

describe("vault — describe / list / stats", () => {
  let test: TestVault;
  beforeEach(async () => {
    test = await createTestVault({
      values: { "ui.theme": "dark", "ui.locale": "en" },
      secrets: { "openrouter.apiKey": "sk", "anthropic.apiKey": "sk-ant" },
    });
  });
  afterEach(async () => {
    await test.dispose();
  });

  it("describe() returns metadata without the value", async () => {
    const desc = await test.vault.describe("openrouter.apiKey");
    expect(desc).toMatchObject({
      key: "openrouter.apiKey",
      source: "keychain-encrypted",
      sensitive: true,
    });
    expect(JSON.stringify(desc)).not.toContain("sk");
  });

  it("describe() returns null for missing keys", async () => {
    expect(await test.vault.describe("missing")).toBeNull();
  });

  it("list() returns all keys", async () => {
    const keys = await test.vault.list();
    expect(keys.slice().sort()).toEqual([
      "anthropic.apiKey",
      "openrouter.apiKey",
      "ui.locale",
      "ui.theme",
    ]);
  });

  it("list() with prefix filters", async () => {
    expect((await test.vault.list("ui")).slice().sort()).toEqual([
      "ui.locale",
      "ui.theme",
    ]);
    expect((await test.vault.list("openrouter")).slice().sort()).toEqual([
      "openrouter.apiKey",
    ]);
  });

  it("list() prefix matches segments only — not substrings", async () => {
    // Regression: a previous filter included `k.startsWith(prefix)`
    // which made `list("ui")` match keys like `ui_legacy` or `uib`.
    // Prefix must be a proper segment.
    await test.vault.set("ui_legacy_thing", "x");
    await test.vault.set("uib", "y");
    const result = (await test.vault.list("ui")).slice().sort();
    expect(result).toEqual(["ui.locale", "ui.theme"]);
    expect(result).not.toContain("ui_legacy_thing");
    expect(result).not.toContain("uib");
  });

  it("stats() returns counts by kind", async () => {
    expect(await test.vault.stats()).toEqual({
      total: 4,
      sensitive: 2,
      nonSensitive: 2,
      references: 0,
    });
  });
});

describe("vault — references (1Password, Proton Pass)", () => {
  let test: TestVault;
  beforeEach(async () => {
    test = await createTestVault();
  });
  afterEach(async () => {
    await test.dispose();
  });

  it("setReference stores a reference, not the value", async () => {
    await test.vault.setReference("openrouter.apiKey", {
      source: "1password",
      path: "Personal/OpenRouter/api-key",
    });
    const raw = await fs.readFile(test.storePath, "utf8");
    expect(raw).toContain("1password");
    expect(raw).toContain("Personal/OpenRouter/api-key");
  });

  it("describe() reports the password manager source", async () => {
    await test.vault.setReference("openrouter.apiKey", {
      source: "1password",
      path: "Personal/OpenRouter/api-key",
    });
    const desc = await test.vault.describe("openrouter.apiKey");
    expect(desc).toMatchObject({
      source: "1password",
      sensitive: true,
    });
  });

  it("rejects unsupported sources", async () => {
    await expect(
      test.vault.setReference("k", {
        // @ts-expect-error exercises runtime validation for unsupported sources.
        source: "lastpass",
        path: "x",
      }),
    ).rejects.toThrow();
  });

  it("rejects empty path", async () => {
    await expect(
      test.vault.setReference("k", { source: "1password", path: "" }),
    ).rejects.toThrow();
  });

  it("stats() counts references separately", async () => {
    await test.vault.set("ui.theme", "dark");
    await test.vault.set("openai.apiKey", "k", { sensitive: true });
    await test.vault.setReference("openrouter.apiKey", {
      source: "1password",
      path: "X/Y/z",
    });
    expect(await test.vault.stats()).toEqual({
      total: 3,
      sensitive: 1,
      nonSensitive: 1,
      references: 1,
    });
  });
});

describe("vault — audit log", () => {
  let test: TestVault;
  beforeEach(async () => {
    test = await createTestVault();
  });
  afterEach(async () => {
    await test.dispose();
  });

  it("records every operation with action + key", async () => {
    await test.vault.set("ui.theme", "dark");
    await test.vault.set("openrouter.apiKey", "sk", { sensitive: true });
    await test.vault.get("openrouter.apiKey");
    await test.vault.remove("ui.theme");

    const records = await test.getAuditRecords();
    expect(records.map((r) => r.action)).toEqual([
      "set",
      "set",
      "get",
      "remove",
    ]);
    expect(records.map((r) => r.key)).toEqual([
      "ui.theme",
      "openrouter.apiKey",
      "openrouter.apiKey",
      "ui.theme",
    ]);
  });

  it("never includes the secret value", async () => {
    const SECRET = "sk-or-v1-MUST-NOT-LEAK";
    await test.vault.set("openrouter.apiKey", SECRET, { sensitive: true });
    await test.vault.get("openrouter.apiKey");
    await test.vault.reveal("openrouter.apiKey", "settings-ui");
    const raw = await fs.readFile(test.auditLogPath, "utf8");
    expect(raw).not.toContain(SECRET);
  });

  it("reveal() captures the caller id", async () => {
    await test.vault.set("k", "v", { sensitive: true });
    await test.vault.reveal("k", "settings-ui");
    const records = await test.getAuditRecords();
    expect(records.at(-1)).toMatchObject({
      action: "reveal",
      key: "k",
      caller: "settings-ui",
    });
  });

  it("clearAuditLog truncates between assertion phases", async () => {
    await test.vault.set("k", "v");
    expect((await test.getAuditRecords()).length).toBeGreaterThan(0);
    await test.clearAuditLog();
    expect(await test.getAuditRecords()).toEqual([]);
  });
});

describe("vault — atomicity + concurrency", () => {
  let test: TestVault;
  beforeEach(async () => {
    test = await createTestVault();
  });
  afterEach(async () => {
    await test.dispose();
  });

  it("concurrent set() calls do not lose writes", async () => {
    await Promise.all([
      test.vault.set("a", "1"),
      test.vault.set("b", "2"),
      test.vault.set("c", "3"),
      test.vault.set("d", "4"),
      test.vault.set("e", "5"),
    ]);
    expect(await test.vault.get("a")).toBe("1");
    expect(await test.vault.get("b")).toBe("2");
    expect(await test.vault.get("c")).toBe("3");
    expect(await test.vault.get("d")).toBe("4");
    expect(await test.vault.get("e")).toBe("5");
  });

  it("file is written 0600", async () => {
    await test.vault.set("k", "v");
    const stat = await fs.stat(test.storePath);
    // POSIX mode bits aren't honoured on Windows; fs.stat returns 0o666
    // for any writable file regardless of how it was created.
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("does not leave a .tmp file behind on success", async () => {
    await test.vault.set("k", "v");
    // Walk the parent dir for any leftover *.tmp* under our store filename.
    const path = await import("node:path");
    const dir = path.dirname(test.storePath);
    const base = path.basename(test.storePath);
    const entries = await fs.readdir(dir);
    const leftovers = entries.filter(
      (f) => f.startsWith(`${base}.tmp.`) || f === `${base}.tmp`,
    );
    expect(leftovers).toEqual([]);
  });

  it("uses a unique tmp filename per write so two concurrent writes can't collide", async () => {
    // Drive 50 parallel writes; the loser of each rename race must NOT
    // overwrite a tmp the winner is still using. This is a regression test
    // for the fixed-name `${path}.tmp` race that previously dropped writes
    // when two VaultImpl instances pointed at the same store.
    const writes = Array.from({ length: 50 }, (_, i) =>
      test.vault.set(`stress-${i}`, `value-${i}`),
    );
    await Promise.all(writes);
    for (let i = 0; i < 50; i++) {
      expect(await test.vault.get(`stress-${i}`)).toBe(`value-${i}`);
    }
  });
});

describe("vault — bug-fix demonstrations", () => {
  let test: TestVault;
  beforeEach(async () => {
    test = await createTestVault();
  });
  afterEach(async () => {
    await test.dispose();
  });

  /**
   * The user's original bug: the legacy save path used
   * `Object.values(config).find(non-empty)` to identify the API key,
   * which depended on JS object iteration order. Typing the model
   * field before the API-key field caused the model slug to overwrite
   * the API key.
   *
   * The vault's typed API makes this impossible. Each field is set by
   * its key; the vault never guesses.
   */
  it("typing model before key cannot overwrite the API key", async () => {
    // User's actual flow: set model first, then key.
    await test.vault.set("openrouter.largeModel", "tencent/hy3-preview");
    await test.vault.set("openrouter.apiKey", "sk-or-v1-real-key", {
      sensitive: true,
    });
    expect(await test.vault.get("openrouter.apiKey")).toBe("sk-or-v1-real-key");
    expect(await test.vault.get("openrouter.largeModel")).toBe(
      "tencent/hy3-preview",
    );
  });

  /**
   * "No reveal" bug — users cannot inspect what's saved. The vault
   * provides explicit `reveal()` for Settings UI to round-trip a saved
   * value, with the read recorded in the audit log.
   */
  it("reveal() returns the saved value AND audits the read", async () => {
    await test.vault.set("openrouter.apiKey", "sk-or-v1-saved", {
      sensitive: true,
    });
    expect(await test.vault.reveal("openrouter.apiKey", "settings-ui")).toBe(
      "sk-or-v1-saved",
    );
    const records = await test.getAuditRecords();
    expect(records.at(-1)).toMatchObject({
      action: "reveal",
      key: "openrouter.apiKey",
      caller: "settings-ui",
    });
  });
});
