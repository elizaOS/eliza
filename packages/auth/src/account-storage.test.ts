/**
 * Real-filesystem coverage for account-storage path containment, explicit
 * ownership policies, symlink resistance, and transactional deletion.
 */

import fs, { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AccountCredentialRecord,
  commitAccountDeletions,
  createIsolatedAccountStoragePolicy,
  deleteAccount,
  listAccounts,
  loadAccount,
  preflightAccountDeletions,
  preflightProviderAccountDeletions,
  saveAccount,
  touchAccount,
} from "./account-storage.ts";

let stateRoot: string;

function record(id: string): AccountCredentialRecord {
  return {
    id,
    providerId: "openai-codex",
    label: id,
    source: "oauth",
    credentials: {
      access: `access-${id}`,
      refresh: `refresh-${id}`,
      expires: Date.now() + 60_000,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  stateRoot = mkdtempSync(path.join(tmpdir(), "eliza-account-storage-"));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

describe("explicit account storage ownership", () => {
  it("performs every mutator inside the policy's canonical provider root", () => {
    const policy = createIsolatedAccountStoragePolicy(stateRoot);
    const providerRoot = path.join(stateRoot, "auth", "openai-codex");
    const file = path.join(providerRoot, "account-1.json");

    saveAccount(record("account-1"), policy);
    expect(
      fs
        .realpathSync(file)
        .startsWith(`${fs.realpathSync(providerRoot)}${path.sep}`),
    ).toBe(true);
    expect(loadAccount("openai-codex", "account-1", policy)?.id).toBe(
      "account-1",
    );
    expect(
      listAccounts("openai-codex", policy).map((entry) => entry.id),
    ).toEqual(["account-1"]);

    touchAccount("openai-codex", "account-1", policy);
    expect(
      loadAccount("openai-codex", "account-1", policy)?.lastUsedAt,
    ).toEqual(expect.any(Number));

    deleteAccount("openai-codex", "account-1", policy);
    expect(fs.existsSync(file)).toBe(false);
  });

  it.each([
    "../escape",
    "..\\escape",
    "a/b",
    "a\\b",
    "/absolute",
    "C:\\absolute",
    "%2e%2e%2fescape",
    "%2Fabsolute",
    "%5cwindows",
    "two..dots",
    ".",
  ])("rejects unsafe account id %j before every filesystem operation", (id) => {
    const policy = createIsolatedAccountStoragePolicy(stateRoot);
    const operations = [
      () => saveAccount(record(id), policy),
      () => loadAccount("openai-codex", id, policy),
      () => touchAccount("openai-codex", id, policy),
      () => deleteAccount("openai-codex", id, policy),
    ];

    for (const operation of operations) {
      expect(operation).toThrow(
        expect.objectContaining({ code: "AUTH_CREDENTIAL_ACCOUNT_ID_INVALID" }),
      );
    }
    expect(fs.readdirSync(stateRoot)).toEqual([]);
  });

  it("rejects an isolated root whose physical path escapes the OS temp directory", () => {
    const linkedRoot = path.join(stateRoot, "linked-root");
    symlinkSync(path.parse(stateRoot).root, linkedRoot, "dir");

    expect(() => createIsolatedAccountStoragePolicy(linkedRoot)).toThrow(
      expect.objectContaining({
        code: "AUTH_CREDENTIAL_ISOLATED_ROOT_REQUIRED",
      }),
    );
  });

  it("rejects a provider-directory symlink for save, load, touch, and delete", () => {
    const policy = createIsolatedAccountStoragePolicy(stateRoot);
    const outside = mkdtempSync(path.join(tmpdir(), "eliza-account-outside-"));
    const authRoot = path.join(stateRoot, "auth");
    fs.mkdirSync(authRoot, { recursive: true });
    symlinkSync(outside, path.join(authRoot, "openai-codex"), "dir");

    try {
      for (const operation of [
        () => saveAccount(record("safe-id"), policy),
        () => loadAccount("openai-codex", "safe-id", policy),
        () => touchAccount("openai-codex", "safe-id", policy),
        () => deleteAccount("openai-codex", "safe-id", policy),
      ]) {
        expect(operation).toThrow(
          expect.objectContaining({ code: "AUTH_CREDENTIAL_PATH_ESCAPE" }),
        );
      }
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects an account-file symlink for every mutator", () => {
    const policy = createIsolatedAccountStoragePolicy(stateRoot);
    const outside = path.join(stateRoot, "outside.json");
    fs.writeFileSync(outside, "outside-must-survive");
    const providerRoot = path.join(stateRoot, "auth", "openai-codex");
    fs.mkdirSync(providerRoot, { recursive: true });
    symlinkSync(outside, path.join(providerRoot, "safe-id.json"), "file");

    for (const operation of [
      () => saveAccount(record("safe-id"), policy),
      () => loadAccount("openai-codex", "safe-id", policy),
      () => listAccounts("openai-codex", policy),
      () => touchAccount("openai-codex", "safe-id", policy),
      () => deleteAccount("openai-codex", "safe-id", policy),
    ]) {
      expect(operation).toThrow(
        expect.objectContaining({ code: "AUTH_CREDENTIAL_PATH_ESCAPE" }),
      );
    }
    expect(fs.readFileSync(outside, "utf8")).toBe("outside-must-survive");
  });

  it("rejects a storage root replaced by a symlink after policy creation", () => {
    const policy = createIsolatedAccountStoragePolicy(stateRoot);
    const originalRoot = `${stateRoot}-original`;
    const outside = `${stateRoot}-outside`;
    fs.mkdirSync(outside);
    fs.renameSync(stateRoot, originalRoot);
    symlinkSync(outside, stateRoot, "dir");

    try {
      for (const operation of [
        () => saveAccount(record("safe-id"), policy),
        () => loadAccount("openai-codex", "safe-id", policy),
        () => listAccounts("openai-codex", policy),
      ]) {
        expect(operation).toThrow(
          expect.objectContaining({
            code: "AUTH_CREDENTIAL_STORAGE_ROOT_CHANGED",
          }),
        );
      }
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.unlinkSync(stateRoot);
      fs.renameSync(originalRoot, stateRoot);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("preflights all deletion targets before removing any account", () => {
    const policy = createIsolatedAccountStoragePolicy(stateRoot);
    saveAccount(record("first"), policy);
    saveAccount(record("second"), policy);
    const plan = preflightAccountDeletions(
      [
        { provider: "openai-codex", accountId: "first" },
        { provider: "openai-codex", accountId: "second" },
      ],
      policy,
    );
    const secondFile = path.join(
      stateRoot,
      "auth",
      "openai-codex",
      "second.json",
    );
    fs.writeFileSync(secondFile, `${fs.readFileSync(secondFile, "utf8")} `);

    expect(() => commitAccountDeletions(plan)).toThrow(
      expect.objectContaining({
        code: "AUTH_CREDENTIAL_DELETE_TARGET_CHANGED",
      }),
    );
    expect(loadAccount("openai-codex", "first", policy)).not.toBeNull();
    expect(fs.existsSync(secondFile)).toBe(true);
  });

  it("provider reset plans delete malformed credential JSON by safe filename", () => {
    const policy = createIsolatedAccountStoragePolicy(stateRoot);
    const providerRoot = path.join(stateRoot, "auth", "openai-codex");
    fs.mkdirSync(providerRoot, { recursive: true });
    const malformed = path.join(providerRoot, "malformed-account.json");
    fs.writeFileSync(malformed, "not-json", { mode: 0o600 });

    const plan = preflightProviderAccountDeletions(["openai-codex"], policy);
    expect(commitAccountDeletions(plan)).toBe(1);
    expect(fs.existsSync(malformed)).toBe(false);
  });
});
