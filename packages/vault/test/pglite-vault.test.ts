/**
 * Parity tests for PgliteVaultImpl.
 *
 * Exercises the same Vault interface as VaultImpl. Each test uses an
 * isolated tmp directory + in-memory master key, so concurrent tests
 * never collide on the PGlite single-writer constraint.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateMasterKey } from "../src/crypto.js";
import { inMemoryMasterKey } from "../src/master-key.js";
import { PgliteVaultImpl } from "../src/pglite-vault.js";
import { VaultMissError } from "../src/vault.js";

describe("PgliteVaultImpl", () => {
  let workDir: string;
  let vault: PgliteVaultImpl;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "vault-pglite-"));
    vault = new PgliteVaultImpl({
      dataDir: join(workDir, ".vault-pglite"),
      masterKey: inMemoryMasterKey(generateMasterKey()),
      auditPath: join(workDir, "audit", "vault.jsonl"),
    });
  });

  afterEach(async () => {
    await vault.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it("set + get round-trips a non-sensitive value", async () => {
    await vault.set("ui.theme", "dark");
    expect(await vault.get("ui.theme")).toBe("dark");
  });

  it("set + get round-trips a sensitive value", async () => {
    await vault.set("openrouter.apiKey", "sk-or-v1-secret", {
      sensitive: true,
    });
    expect(await vault.get("openrouter.apiKey")).toBe("sk-or-v1-secret");
  });

  it("get throws VaultMissError for missing key", async () => {
    await expect(vault.get("nonexistent")).rejects.toBeInstanceOf(
      VaultMissError,
    );
  });

  it("has returns true/false correctly", async () => {
    expect(await vault.has("k")).toBe(false);
    await vault.set("k", "v");
    expect(await vault.has("k")).toBe(true);
    await vault.remove("k");
    expect(await vault.has("k")).toBe(false);
  });

  it("remove is idempotent", async () => {
    await vault.set("k", "v");
    await vault.remove("k");
    await expect(vault.remove("k")).resolves.toBeUndefined();
  });

  it("list returns all keys when no prefix", async () => {
    await vault.set("a", "1");
    await vault.set("b", "2");
    await vault.set("c.d", "3");
    expect(await vault.list()).toEqual(["a", "b", "c.d"]);
  });

  it("list with prefix matches segment, not substring", async () => {
    await vault.set("ui", "1");
    await vault.set("ui.theme", "2");
    await vault.set("ui_legacy", "3");
    await vault.set("uib", "4");
    const got = await vault.list("ui");
    expect(got).toEqual(["ui", "ui.theme"]);
  });

  it("set replaces a sensitive value with a non-sensitive one", async () => {
    await vault.set("k", "secret", { sensitive: true });
    await vault.set("k", "plain");
    expect(await vault.get("k")).toBe("plain");
    const desc = await vault.describe("k");
    expect(desc?.sensitive).toBe(false);
  });

  it("set replaces a non-sensitive value with a sensitive one", async () => {
    await vault.set("k", "plain");
    await vault.set("k", "secret", { sensitive: true });
    expect(await vault.get("k")).toBe("secret");
    const desc = await vault.describe("k");
    expect(desc?.sensitive).toBe(true);
  });

  it("describe returns null for missing key", async () => {
    expect(await vault.describe("none")).toBeNull();
  });

  it("describe returns correct shape for value/secret/reference", async () => {
    await vault.set("v", "x");
    await vault.set("s", "x", { sensitive: true });
    await vault.setReference("r", { source: "1password", path: "op://x/y" });
    expect((await vault.describe("v"))?.source).toBe("file");
    expect((await vault.describe("s"))?.source).toBe("keychain-encrypted");
    expect((await vault.describe("r"))?.source).toBe("1password");
  });

  it("stats counts each kind", async () => {
    await vault.set("v1", "x");
    await vault.set("v2", "y");
    await vault.set("s1", "z", { sensitive: true });
    await vault.setReference("r1", {
      source: "protonpass",
      path: "/x/y",
    });
    const s = await vault.stats();
    expect(s).toEqual({
      total: 4,
      sensitive: 1,
      nonSensitive: 2,
      references: 1,
    });
  });

  it("rejects empty key", async () => {
    await expect(vault.set("", "v")).rejects.toThrow(/non-empty string/);
  });

  it("rejects non-string value", async () => {
    await expect(
      // @ts-expect-error exercises runtime validation for invalid callers.
      vault.set("k", 123),
    ).rejects.toThrow(
      /must be a string/,
    );
  });

  it("ciphertext is opaque on disk (decrypt requires the master key)", async () => {
    // Use a fresh known master key so we can prove a different key fails
    // to decrypt — i.e. the on-disk row really is encrypted.
    const knownKey = generateMasterKey();
    const dir = await mkdtemp(join(tmpdir(), "vault-pglite-known-"));
    const v1 = new PgliteVaultImpl({
      dataDir: join(dir, ".vault-pglite"),
      masterKey: inMemoryMasterKey(knownKey),
      auditPath: join(dir, "audit", "vault.jsonl"),
    });
    await v1.set("k", "secret-value", { sensitive: true });
    expect(await v1.get("k")).toBe("secret-value");
    await v1.close();

    const wrongKey = generateMasterKey();
    const v2 = new PgliteVaultImpl({
      dataDir: join(dir, ".vault-pglite"),
      masterKey: inMemoryMasterKey(wrongKey),
      auditPath: join(dir, "audit", "vault.jsonl"),
    });
    await expect(v2.get("k")).rejects.toThrow(/decryption failed/);
    await v2.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe("legacy vault.json migration", () => {
    it("imports plaintext, secret, and reference entries verbatim", async () => {
      const legacyDir = await mkdtemp(join(tmpdir(), "vault-legacy-"));
      const legacyPath = join(legacyDir, "vault.json");

      // Build a legacy store via the existing file-based vault, then point a
      // PGlite vault at it for one-shot migration. Same master key both
      // ends, so decrypting in PGlite proves the ciphertext round-trips
      // verbatim.
      const masterKey = generateMasterKey();
      const { createVault } = await import("../src/vault.js");
      // Force the file backend regardless of env default.
      const prev = process.env.MILADY_VAULT_BACKEND;
      process.env.MILADY_VAULT_BACKEND = "file";
      const fileVault2 = createVault({
        workDir: legacyDir,
        masterKey: inMemoryMasterKey(masterKey),
      });
      await fileVault2.set("ui.theme", "dark");
      await fileVault2.set("openrouter.apiKey", "sk-or-secret", {
        sensitive: true,
      });
      await fileVault2.setReference("github.token", {
        source: "1password",
        path: "op://Personal/GitHub/token",
      });
      if (prev === undefined) delete process.env.MILADY_VAULT_BACKEND;
      else process.env.MILADY_VAULT_BACKEND = prev;

      // Open a PGlite vault pointing at the legacy file
      const pgDir = await mkdtemp(join(tmpdir(), "vault-pglite-mig-"));
      const pg = new PgliteVaultImpl({
        dataDir: join(pgDir, ".vault-pglite"),
        legacyStorePath: legacyPath,
        masterKey: inMemoryMasterKey(masterKey),
        auditPath: join(pgDir, "audit", "vault.jsonl"),
      });

      expect(await pg.get("ui.theme")).toBe("dark");
      expect(await pg.get("openrouter.apiKey")).toBe("sk-or-secret");
      // Reference resolution would call out to 1Password CLI; just describe.
      const refDesc = await pg.describe("github.token");
      expect(refDesc?.source).toBe("1password");
      // Sentinel row written
      expect(await pg.has("_migrated_from_file_v1")).toBe(true);

      await pg.close();
      await rm(pgDir, { recursive: true, force: true });
      await rm(legacyDir, { recursive: true, force: true });
    });

    it("does not re-migrate when table already has rows", async () => {
      const legacyDir = await mkdtemp(join(tmpdir(), "vault-legacy-skip-"));
      const legacyPath = join(legacyDir, "vault.json");
      // Write a minimal legacy file
      await writeFile(
        legacyPath,
        JSON.stringify({
          version: 1,
          entries: {
            shouldNotImport: {
              kind: "value",
              value: "from-legacy",
              lastModified: 1,
            },
          },
        }),
      );

      const pgDir = await mkdtemp(join(tmpdir(), "vault-pglite-skip-"));
      const masterKey = generateMasterKey();
      const pg1 = new PgliteVaultImpl({
        dataDir: join(pgDir, ".vault-pglite"),
        masterKey: inMemoryMasterKey(masterKey),
        auditPath: join(pgDir, "audit", "vault.jsonl"),
      });
      await pg1.set("preexisting", "x");
      await pg1.close();

      // Now open with legacyStorePath — table already has a row, so the
      // legacy file should NOT be merged in.
      const pg2 = new PgliteVaultImpl({
        dataDir: join(pgDir, ".vault-pglite"),
        legacyStorePath: legacyPath,
        masterKey: inMemoryMasterKey(masterKey),
        auditPath: join(pgDir, "audit", "vault.jsonl"),
      });
      expect(await pg2.has("shouldNotImport")).toBe(false);
      expect(await pg2.has("preexisting")).toBe(true);
      await pg2.close();
      await rm(pgDir, { recursive: true, force: true });
      await rm(legacyDir, { recursive: true, force: true });
    });
  });
});
