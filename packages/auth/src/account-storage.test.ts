/**
 * Credential deletion guards prevent test workers from unlinking account files
 * in a developer's persistent Eliza state. The destructive path is exercised
 * with mocked unlink calls for non-temp probes and real missing files only under
 * mkdtemp state roots.
 */

import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAccount } from "./account-storage";

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
  it("refuses an inherited non-temporary ELIZA_HOME before unlinking", () => {
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

    expect(() =>
      deleteAccount("anthropic-subscription", "guard-probe-does-not-exist"),
    ).toThrow(
      /Refusing to delete credentials from a non-temporary Eliza state directory/,
    );
    expect(unlink).not.toHaveBeenCalled();
  });

  it("refuses a non-temporary ELIZA_STATE_DIR when ELIZA_HOME is unset", () => {
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

  it("allows deletion when ELIZA_HOME points under the OS temp directory", () => {
    const home = mkdtempSync(path.join(tmpdir(), "eliza-account-storage-"));
    process.env.ELIZA_HOME = home;
    delete process.env.ELIZA_STATE_DIR;
    process.env.VITEST = "true";

    try {
      expect(() =>
        deleteAccount("anthropic-subscription", "missing-temp-account"),
      ).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("allows deletion when ELIZA_STATE_DIR resolves under the OS temp directory", () => {
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

  it("allows an explicit test override for non-temporary state", () => {
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
