/**
 * Regression guard for the local vault-root file lifecycle.
 *
 * The owner-only mode check is POSIX-only: Windows reports every writable
 * file as mode 0o666 (group/other permission bits do not exist), so before
 * the gate was drawn around `process.getuid`, the check convicted 100% of
 * writable files on Windows — including the `.master-password` this module
 * had just created with 0o600 — permanently breaking first-launch steward
 * setup on the packaged Windows desktop. On POSIX the mode and uid checks
 * are unchanged, which the POSIX-gated unsafe-file test below pins.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateLoginMasterPassword } from "./master-password";

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String((error as { code?: string }).code)
    : "";
}

describe("login master password file lifecycle", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-master-password-"));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates, validates, and reads back the local vault root on every platform", () => {
    const created = loadOrCreateLoginMasterPassword(dataDir);
    expect(created).toMatch(/^[0-9a-f]{64}$/);

    // The existing file is validated (open, unlinked-follow, atomic link
    // path) and the same root is returned on every later start.
    expect(loadOrCreateLoginMasterPassword(dataDir)).toBe(created);

    // A supplied password matching the persisted root is accepted.
    expect(loadOrCreateLoginMasterPassword(dataDir, created)).toBe(created);

    // The published file carries the root.
    const persisted = fs
      .readFileSync(path.join(dataDir, ".master-password"), "utf8")
      .trim();
    expect(persisted).toBe(created);
  });

  it("still rejects a supplied password that does not match the persisted root", () => {
    const created = loadOrCreateLoginMasterPassword(dataDir);
    expect(() =>
      loadOrCreateLoginMasterPassword(dataDir, `${created}0`),
    ).toThrowError(
      expect.objectContaining({ code: "LOGIN_PASSWORD_CONFLICT" }),
    );
  });

  it.skipIf(process.platform === "win32")(
    "still refuses a group-readable password file on POSIX",
    () => {
      const created = loadOrCreateLoginMasterPassword(dataDir);
      const target = path.join(dataDir, ".master-password");
      fs.chmodSync(target, 0o644);
      try {
        loadOrCreateLoginMasterPassword(dataDir);
        expect.unreachable("a group-readable file must be refused");
      } catch (error) {
        // The POSIX hardening is bit-for-bit unchanged by the platform gate.
        expect(errorCode(error)).toBe("LOGIN_PASSWORD_FILE_UNSAFE");
      } finally {
        fs.chmodSync(target, 0o600);
      }
      expect(created).toMatch(/^[0-9a-f]{64}$/);
    },
  );
});
