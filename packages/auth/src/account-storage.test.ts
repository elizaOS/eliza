import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteAccount } from "./account-storage";

const originalElizaHome = process.env.ELIZA_HOME;
const originalOverride = process.env.ELIZA_ALLOW_REAL_STATE_IN_TESTS;

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalElizaHome === undefined) delete process.env.ELIZA_HOME;
  else process.env.ELIZA_HOME = originalElizaHome;
  if (originalOverride === undefined) {
    delete process.env.ELIZA_ALLOW_REAL_STATE_IN_TESTS;
  } else {
    process.env.ELIZA_ALLOW_REAL_STATE_IN_TESTS = originalOverride;
  }
});

describe("credential deletion test-state guard", () => {
  it("refuses deletion from the real user state directory in a test process", () => {
    delete process.env.ELIZA_HOME;
    delete process.env.ELIZA_ALLOW_REAL_STATE_IN_TESTS;
    vi.stubEnv("VITEST", "true");

    expect(() =>
      deleteAccount("anthropic-subscription", "guard-probe-does-not-exist"),
    ).toThrow(
      /Refusing to delete credentials from a non-temporary Eliza state directory/,
    );
  });

  it("refuses an inherited non-temporary ELIZA_HOME", () => {
    process.env.ELIZA_HOME = path.join(process.cwd(), ".real-state-probe");
    vi.stubEnv("VITEST", "true");

    expect(() =>
      deleteAccount("anthropic-subscription", "guard-probe-does-not-exist"),
    ).toThrow(/non-temporary Eliza state directory/);
  });

  it("allows deletion when ELIZA_HOME is isolated", () => {
    const home = mkdtempSync(path.join(tmpdir(), "eliza-account-storage-"));
    process.env.ELIZA_HOME = home;
    vi.stubEnv("VITEST", "true");
    try {
      expect(() =>
        deleteAccount("anthropic-subscription", "missing-isolated-account"),
      ).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("allows an isolated ELIZA_STATE_DIR", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "eliza-state-storage-"));
    delete process.env.ELIZA_HOME;
    vi.stubEnv("ELIZA_STATE_DIR", stateDir);
    vi.stubEnv("VITEST", "true");
    try {
      expect(() =>
        deleteAccount("anthropic-subscription", "missing-isolated-account"),
      ).not.toThrow();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("allows an explicit real-state test override", () => {
    delete process.env.ELIZA_HOME;
    vi.stubEnv("VITEST", "true");
    process.env.ELIZA_ALLOW_REAL_STATE_IN_TESTS = "1";

    expect(() =>
      deleteAccount("anthropic-subscription", "guard-probe-does-not-exist"),
    ).not.toThrow();
  });
});
