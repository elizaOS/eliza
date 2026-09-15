/** Exercises vault-key continuity and migration refusal with real encryption and filesystem state. */
import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEmbeddedSecrets } from "../embedded-secrets";
import { KeyStore } from "../vault/src/keystore";

const directories: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "login-secrets-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

test("a new local database reopens encrypted keys with the persisted derivation choice", () => {
  const path = directory();
  const password = randomBytes(32).toString("hex");
  const first = resolveEmbeddedSecrets(path, password, {});
  const encrypted = new KeyStore(password, first.kdfSalt).encrypt(
    "private key material",
  );
  const resumed = resolveEmbeddedSecrets(path, password, {});
  expect(new KeyStore(password, resumed.kdfSalt).decrypt(encrypted)).toBe(
    "private key material",
  );
  expect(() =>
    new KeyStore(password, resumed.auditKey).decrypt(encrypted),
  ).toThrow();
});

test("existing databases require original keys instead of inventing a replacement", () => {
  const path = directory();
  writeFileSync(join(path, "PG_VERSION"), "17");
  expect(() => resolveEmbeddedSecrets(path, "password", {})).toThrow(
    expect.objectContaining({ code: "LOGIN_MIGRATION_KEYS_REQUIRED" }),
  );
});

test("a previously configured audit key cannot silently change to a derived key", () => {
  const path = directory();
  resolveEmbeddedSecrets(path, "password", {
    auditKey: randomBytes(32).toString("hex"),
  });
  expect(() => resolveEmbeddedSecrets(path, "password", {})).toThrow(
    expect.objectContaining({ code: "LOGIN_CONFIGURED_KEYS_REQUIRED" }),
  );
});
