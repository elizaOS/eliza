/**
 * `queryTccStatus` used to answer `null` both for "TCC has no row for this
 * service" and for "the read itself failed" (locked/corrupt TCC.db, missing
 * `sqlite3`). Probers map `null` to `not-determined` with `canRequest: true`,
 * so a broken probe was shown to the user as "you were never asked" — the same
 * state as a fresh install — instead of an unavailable permission.
 *
 * These tests pin the split: absence and macOS withholding the file stay
 * `null`; a failed read rejects with `TCC_QUERY_FAILED`.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

type ExecOutcome =
  | { stdout: string; stderr: string }
  | (Error & { stderr?: string; code?: string | number });

const fixture = vi.hoisted(() => ({
  /** Does `<home>/Library/Application Support/com.apple.TCC/TCC.db` exist? */
  dbPresent: true,
  /** What the mocked `sqlite3` call resolves or rejects with. */
  outcome: { stdout: "", stderr: "" } as ExecOutcome,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (target: unknown) => {
      const file = String(target);
      return file.endsWith("TCC.db") ? fixture.dbPresent : actual.existsSync(target as never);
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, result?: unknown) => void,
    ) => {
      const outcome = fixture.outcome;
      if (outcome instanceof Error) {
        callback(outcome);
        return;
      }
      callback(null, outcome);
    },
  };
});

// `IS_DARWIN` is captured at module load, so answer "darwin" before importing.
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
Object.defineProperty(process, "platform", {
  value: "darwin",
  configurable: true,
});

const { queryAppleEventsTccStatus, queryTccStatus } = await import("./_bridge.ts");

afterAll(() => {
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

const SERVICE = "kTCCServiceScreenCapture";
const BUNDLE_ID = "ai.elizaos.app";

function sqliteFailure(options: {
  stderr?: string;
  code?: string | number;
}): Error & { stderr?: string; code?: string | number } {
  return Object.assign(
    new Error(options.stderr?.trim() || "Command failed: sqlite3"),
    { cmd: "sqlite3", ...options },
  );
}

describe("queryTccStatus", () => {
  beforeEach(() => {
    fixture.dbPresent = true;
    fixture.outcome = { stdout: "", stderr: "" };
  });

  it("maps a granted row", async () => {
    fixture.outcome = { stdout: "2\n", stderr: "" };
    await expect(queryTccStatus(SERVICE, BUNDLE_ID)).resolves.toBe("granted");
  });

  it("maps a denied row", async () => {
    fixture.outcome = { stdout: "0\n", stderr: "" };
    await expect(queryTccStatus(SERVICE, BUNDLE_ID)).resolves.toBe("denied");
  });

  it("treats a missing per-user TCC.db as not-determined", async () => {
    // No database yet: the user simply has no recorded decision.
    fixture.dbPresent = false;
    await expect(queryTccStatus(SERVICE, BUNDLE_ID)).resolves.toBeNull();
  });

  it("treats a missing row as not-determined", async () => {
    fixture.outcome = { stdout: "", stderr: "" };
    await expect(queryTccStatus(SERVICE, BUNDLE_ID)).resolves.toBeNull();
  });

  it("treats a TCC.db macOS withholds from this process as not-determined", async () => {
    // Without Full Disk Access the read is refused. That is "TCC cannot
    // answer", not a broken probe: the user can still grant the permission.
    fixture.outcome = sqliteFailure({
      stderr: "Error: authorization denied",
      code: 1,
    });
    await expect(queryTccStatus(SERVICE, BUNDLE_ID)).resolves.toBeNull();
  });

  it("surfaces a locked TCC.db instead of reporting no row", async () => {
    fixture.outcome = sqliteFailure({
      stderr: "Error: database is locked",
      code: 1,
    });

    await expect(queryTccStatus(SERVICE, BUNDLE_ID)).rejects.toMatchObject({
      code: "TCC_QUERY_FAILED",
    });
  });

  it("surfaces a corrupt TCC.db instead of reporting no row", async () => {
    fixture.outcome = sqliteFailure({
      stderr: "Error: file is not a database",
      code: 1,
    });

    await expect(queryTccStatus(SERVICE, BUNDLE_ID)).rejects.toMatchObject({
      code: "TCC_QUERY_FAILED",
    });
  });

  it("surfaces a missing sqlite3 binary instead of reporting no row", async () => {
    fixture.outcome = sqliteFailure({ code: "ENOENT" });

    await expect(queryTccStatus(SERVICE, BUNDLE_ID)).rejects.toMatchObject({
      code: "TCC_QUERY_FAILED",
    });
  });
});

const TARGET_BUNDLE_ID = "com.apple.Notes";

describe("queryAppleEventsTccStatus", () => {
  beforeEach(() => {
    fixture.dbPresent = true;
    fixture.outcome = { stdout: "", stderr: "" };
  });

  it("maps a granted row", async () => {
    fixture.outcome = { stdout: "2\n", stderr: "" };
    await expect(
      queryAppleEventsTccStatus(TARGET_BUNDLE_ID, BUNDLE_ID),
    ).resolves.toBe("granted");
  });

  it("maps a denied row", async () => {
    fixture.outcome = { stdout: "0\n", stderr: "" };
    await expect(
      queryAppleEventsTccStatus(TARGET_BUNDLE_ID, BUNDLE_ID),
    ).resolves.toBe("denied");
  });

  it("treats a missing per-user TCC.db as not-determined", async () => {
    fixture.dbPresent = false;
    await expect(
      queryAppleEventsTccStatus(TARGET_BUNDLE_ID, BUNDLE_ID),
    ).resolves.toBeNull();
  });

  it("treats a missing row as not-determined", async () => {
    fixture.outcome = { stdout: "", stderr: "" };
    await expect(
      queryAppleEventsTccStatus(TARGET_BUNDLE_ID, BUNDLE_ID),
    ).resolves.toBeNull();
  });

  it("treats a TCC.db macOS withholds from this process as not-determined", async () => {
    fixture.outcome = sqliteFailure({
      stderr: "Error: authorization denied",
      code: 1,
    });
    await expect(
      queryAppleEventsTccStatus(TARGET_BUNDLE_ID, BUNDLE_ID),
    ).resolves.toBeNull();
  });

  it("surfaces a locked TCC.db instead of reporting no row", async () => {
    fixture.outcome = sqliteFailure({
      stderr: "Error: database is locked",
      code: 1,
    });

    await expect(
      queryAppleEventsTccStatus(TARGET_BUNDLE_ID, BUNDLE_ID),
    ).rejects.toMatchObject({ code: "TCC_QUERY_FAILED" });
  });

  it("surfaces a corrupt TCC.db instead of reporting no row", async () => {
    fixture.outcome = sqliteFailure({
      stderr: "Error: file is not a database",
      code: 1,
    });

    await expect(
      queryAppleEventsTccStatus(TARGET_BUNDLE_ID, BUNDLE_ID),
    ).rejects.toMatchObject({ code: "TCC_QUERY_FAILED" });
  });

  it("surfaces a missing sqlite3 binary instead of reporting no row", async () => {
    fixture.outcome = sqliteFailure({ code: "ENOENT" });

    await expect(
      queryAppleEventsTccStatus(TARGET_BUNDLE_ID, BUNDLE_ID),
    ).rejects.toMatchObject({ code: "TCC_QUERY_FAILED" });
  });
});
