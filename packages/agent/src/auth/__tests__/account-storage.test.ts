/**
 * Unit tests for the per-account credential storage layer.
 *
 * Each test runs against a fresh tmp HOME (via `ELIZA_HOME`) and
 * re-imports the module so the per-process migration latch starts
 * clean.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OAuthCredentials, SubscriptionProvider } from "../types.js";

const ORIGINAL_ELIZA_HOME = process.env.ELIZA_HOME;

function makeTmpHome(): string {
  const dir = path.join(os.tmpdir(), `account-storage-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function importFreshModule() {
  vi.resetModules();
  return await import("../account-storage.js");
}

const sampleCredentials: OAuthCredentials = {
  access: "access-token-1",
  refresh: "refresh-token-1",
  expires: Date.now() + 60_000,
};

describe("account-storage", () => {
  let home: string;

  beforeEach(() => {
    home = makeTmpHome();
    process.env.ELIZA_HOME = home;
  });

  afterEach(() => {
    if (ORIGINAL_ELIZA_HOME === undefined) {
      delete process.env.ELIZA_HOME;
    } else {
      process.env.ELIZA_HOME = ORIGINAL_ELIZA_HOME;
    }
    if (home && fs.existsSync(home)) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("round-trips list → save → list", async () => {
    const { listAccounts, saveAccount } = await importFreshModule();
    const provider: SubscriptionProvider = "openai-codex";
    expect(listAccounts(provider)).toEqual([]);

    const now = Date.now();
    saveAccount({
      id: "personal",
      providerId: provider,
      label: "Personal",
      source: "oauth",
      credentials: sampleCredentials,
      createdAt: now,
      updatedAt: now,
    });
    saveAccount({
      id: "work",
      providerId: provider,
      label: "Work",
      source: "oauth",
      credentials: { ...sampleCredentials, access: "access-token-2" },
      createdAt: now + 1,
      updatedAt: now + 1,
    });

    const all = listAccounts(provider);
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.id).sort()).toEqual(["personal", "work"]);
    expect(all.find((r) => r.id === "personal")?.label).toBe("Personal");
    expect(all.find((r) => r.id === "work")?.credentials.access).toBe(
      "access-token-2",
    );
  });

  it("atomic write does not leave a .tmp file on success", async () => {
    const { saveAccount } = await importFreshModule();
    const provider: SubscriptionProvider = "openai-codex";
    saveAccount({
      id: "default",
      providerId: provider,
      label: "Default",
      source: "oauth",
      credentials: sampleCredentials,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const dir = path.join(home, "auth", provider);
    const files = fs.readdirSync(dir);
    expect(files).toContain("default.json");
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("migrates the legacy single-file format exactly once", async () => {
    const provider: SubscriptionProvider = "anthropic-subscription";
    const authDir = path.join(home, "auth");
    fs.mkdirSync(authDir, { recursive: true });
    const legacyPath = path.join(authDir, `${provider}.json`);
    const legacyCreatedAt = Date.now() - 10_000;
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        provider,
        credentials: sampleCredentials,
        createdAt: legacyCreatedAt,
        updatedAt: legacyCreatedAt,
      }),
      { encoding: "utf-8", mode: 0o600 },
    );

    const { listAccounts, migrateLegacySingleAccount, loadAccount } =
      await importFreshModule();

    // First read should migrate
    const accounts = listAccounts(provider);
    expect(accounts).toHaveLength(1);
    const [record] = accounts;
    expect(record.id).toBe("default");
    expect(record.label).toBe("Default");
    expect(record.source).toBe("oauth");
    expect(record.providerId).toBe(provider);
    expect(record.createdAt).toBe(legacyCreatedAt);
    expect(record.credentials.access).toBe(sampleCredentials.access);

    // Legacy file should be gone, new file should exist with mode 0600
    expect(fs.existsSync(legacyPath)).toBe(false);
    const newFile = path.join(authDir, provider, "default.json");
    expect(fs.existsSync(newFile)).toBe(true);
    const stat = fs.statSync(newFile);
    expect(stat.mode & 0o777).toBe(0o600);

    // Second migrate call should be a no-op
    const second = migrateLegacySingleAccount();
    expect(second.migrated).toEqual([]);

    // The record loaded through `loadAccount` should still match
    const loaded = loadAccount(provider, "default");
    expect(loaded?.credentials.access).toBe(sampleCredentials.access);
  });

  it("loadAccount returns null for missing accounts", async () => {
    const { loadAccount } = await importFreshModule();
    expect(loadAccount("openai-codex", "nope")).toBeNull();
  });

  it("deleteAccount is idempotent", async () => {
    const { saveAccount, deleteAccount, loadAccount } =
      await importFreshModule();
    const provider: SubscriptionProvider = "openai-codex";
    saveAccount({
      id: "x",
      providerId: provider,
      label: "X",
      source: "oauth",
      credentials: sampleCredentials,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(loadAccount(provider, "x")).not.toBeNull();
    deleteAccount(provider, "x");
    expect(loadAccount(provider, "x")).toBeNull();
    // Calling again must not throw
    expect(() => deleteAccount(provider, "x")).not.toThrow();
    expect(() => deleteAccount(provider, "never-existed")).not.toThrow();
  });

  it("touchAccount updates lastUsedAt", async () => {
    const { saveAccount, touchAccount, loadAccount } =
      await importFreshModule();
    const provider: SubscriptionProvider = "openai-codex";
    const created = Date.now() - 60_000;
    saveAccount({
      id: "default",
      providerId: provider,
      label: "Default",
      source: "oauth",
      credentials: sampleCredentials,
      createdAt: created,
      updatedAt: created,
    });
    const before = loadAccount(provider, "default");
    expect(before?.lastUsedAt).toBeUndefined();
    touchAccount(provider, "default");
    const after = loadAccount(provider, "default");
    expect(typeof after?.lastUsedAt).toBe("number");
    expect((after?.lastUsedAt ?? 0) >= created).toBe(true);
  });
});
