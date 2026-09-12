/** Exercises local vault-root persistence and unsafe-file rejection against the real filesystem. */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadOrCreateLoginMasterPassword } from "../master-password";

const directories: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "eliza-login-password-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

it("reopens encrypted state after setup stops before credentials are saved", () => {
  const path = directory();
  const password = loadOrCreateLoginMasterPassword(path);
  const key = createHash("sha256").update(password).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update("wallet private material"),
    cipher.final(),
  ]);
  const resumedKey = createHash("sha256")
    .update(loadOrCreateLoginMasterPassword(path))
    .digest();
  const decipher = createDecipheriv("aes-256-gcm", resumedKey, iv);
  decipher.setAuthTag(cipher.getAuthTag());
  expect(
    Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(),
  ).toBe("wallet private material");
});

it("rejects a conflicting password without replacing the existing root", () => {
  const path = directory();
  loadOrCreateLoginMasterPassword(path, "original-password");
  expect(() =>
    loadOrCreateLoginMasterPassword(path, "replacement-password"),
  ).toThrow(expect.objectContaining({ code: "LOGIN_PASSWORD_CONFLICT" }));
  expect(loadOrCreateLoginMasterPassword(path)).toBe("original-password");
});

it("rejects symbolic links and preserves their target", () => {
  const path = directory();
  const target = join(path, "other-secret");
  writeFileSync(target, "original-secret", { mode: 0o600 });
  symlinkSync(target, join(path, ".master-password"));
  expect(() => loadOrCreateLoginMasterPassword(path)).toThrow();
  expect(readFileSync(target, "utf8")).toBe("original-secret");
});

it("does not invent a password for an existing wallet with missing credentials", () => {
  expect(() =>
    loadOrCreateLoginMasterPassword(directory(), undefined, false),
  ).toThrow(expect.objectContaining({ code: "LOGIN_PASSWORD_MISSING" }));
});
