/**
 * Credential deletion guards prevent test workers from unlinking account files
 * in a developer's persistent Eliza state. The destructive path is exercised
 * with mocked unlink calls for unsafe probes and a real credential file under a
 * mkdtemp state root.
 */

import fs, { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAccount, saveAccount } from "./account-storage";

const ENV_KEYS = [
  "BUN_ENV",
  "ELIZA_ALLOW_REAL_STATE_IN_TESTS",
  "ELIZA_HOME",
  "ELIZA_STATE_DIR",
  "NODE_ENV",
  "VITEST",
] as const;

const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  originalEnv.clear();
});

describe("credential deletion test-state guard", () => {
  it("refuses an inherited non-temporary ELIZA_HOME before unlinking", async () => {
    process.env.ELIZA_HOME = path.join(
      path.sep,
      "var",
      "empty",
      "eliza-live-state-probe",
    );
    delete process.env.ELIZA_ALLOW_REAL_STATE_IN_TESTS;
    process.env.VITEST = "true";
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    let thrown: unknown;
    try {
      deleteAccount("anthropic-subscription", "guard-probe-does-not-exist");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toEqual(
      expect.objectContaining({
        name: "ElizaError",
        code: "AUTH_CREDENTIAL_DELETE_OUTSIDE_TEST_STATE",
        severity: "fatal",
        message: expect.stringMatching(
          /Refusing to delete credentials from a non-temporary Eliza state directory/,
        ),
      }),
    );
    expect(unlink).not.toHaveBeenCalled();
  });

  it("refuses a non-temporary ELIZA_STATE_DIR when ELIZA_HOME is unset", async () => {
    delete process.env.ELIZA_HOME;
    process.env.ELIZA_STATE_DIR = path.join(
      path.sep,
      "var",
      "empty",
      "eliza-state-probe",
    );
    process.env.VITEST = "true";
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    expect(() =>
      deleteAccount("openai-codex", "guard-probe-does-not-exist"),
    ).toThrow(/non-temporary Eliza state directory/);
    expect(unlink).not.toHaveBeenCalled();
  });

  it("allows deletion when ELIZA_HOME points under the OS temp directory", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "eliza-account-storage-"));
    process.env.ELIZA_HOME = home;
    delete process.env.ELIZA_STATE_DIR;
    process.env.VITEST = "true";
    const file = path.join(
      home,
      "auth",
      "anthropic-subscription",
      "temporary-account.json",
    );

    try {
      saveAccount({
        id: "temporary-account",
        providerId: "anthropic-subscription",
        label: "Temporary account",
        source: "oauth",
        credentials: { access: "temporary-access", refresh: "", expires: 0 },
        createdAt: 1,
        updatedAt: 1,
      });
      expect(fs.existsSync(file)).toBe(true);

      deleteAccount("anthropic-subscription", "temporary-account");

      expect(fs.existsSync(file)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("allows deletion when ELIZA_STATE_DIR resolves under the OS temp directory", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "eliza-state-storage-"));
    delete process.env.ELIZA_HOME;
    process.env.ELIZA_STATE_DIR = stateDir;
    process.env.VITEST = "true";

    try {
      expect(() =>
        deleteAccount("openai-codex", "missing-temp-account"),
      ).not.toThrow();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("refuses a temporary path that resolves through a symlink outside the OS temp directory", async () => {
    const container = mkdtempSync(path.join(tmpdir(), "eliza-symlink-guard-"));
    const linkedHome = path.join(container, "linked-home");
    const filesystemRoot = path.parse(process.cwd()).root;
    symlinkSync(
      filesystemRoot,
      linkedHome,
      process.platform === "win32" ? "junction" : "dir",
    );
    process.env.ELIZA_HOME = linkedHome;
    delete process.env.ELIZA_STATE_DIR;
    process.env.VITEST = "true";
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    try {
      expect(() =>
        deleteAccount("openai-codex", "symlink-escape-probe"),
      ).toThrow(/non-temporary Eliza state directory/);
      expect(unlink).not.toHaveBeenCalled();
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });

  it("allows an explicit test override for non-temporary state", async () => {
    process.env.ELIZA_HOME = path.join(
      path.sep,
      "var",
      "empty",
      "eliza-override-probe",
    );
    process.env.ELIZA_ALLOW_REAL_STATE_IN_TESTS = "1";
    process.env.VITEST = "true";
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    expect(() =>
      deleteAccount("anthropic-subscription", "guard-probe-does-not-exist"),
    ).not.toThrow();
    expect(unlink).toHaveBeenCalledTimes(1);
  });
});
