/**
 * Regression: `loadDefaultMasterKeySync` must resolve the persistent master key
 * once per process, not once per caller. `account-storage.ts` calls it for every
 * credential file it decodes, so an un-memoized resolver re-ran the passphrase
 * KDF (or re-spawned the keychain child) N times per `listAccounts()` — the
 * dominant cost of an account-pool lease and the source of multi-second
 * `model:TEXT_EMBEDDING` spans on sol-dev while the embedding backend answered
 * in tens of milliseconds. This test fails on clean develop (KDF runs per call)
 * and passes with the memo.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import * as masterKey from "../src/vault/master-key.js";

const { loadDefaultMasterKeySync } = masterKey;
// Optional on clean develop (the memo + reset helper are what this fix adds).
// Falling back to a no-op keeps the *behavioral* assertions below as the
// bidirectional signal: on clean develop each load re-resolves and returns a
// fresh Buffer, so the reference-identity check fails; with the memo it holds.
const resetLoadDefaultMasterKeySyncCache: () => void =
  (masterKey as { resetLoadDefaultMasterKeySyncCache?: () => void })
    .resetLoadDefaultMasterKeySyncCache ?? (() => {});

const PASSPHRASE = "sol-master-key-cache-test-passphrase";
let priorPassphrase: string | undefined;
let priorDisableKeychain: string | undefined;

beforeEach(() => {
  priorPassphrase = process.env.ELIZA_VAULT_PASSPHRASE;
  priorDisableKeychain = process.env.ELIZA_VAULT_DISABLE_KEYCHAIN;
  // Force the passphrase KDF path so the derivation is counted deterministically
  // without touching the host OS keychain.
  process.env.ELIZA_VAULT_PASSPHRASE = PASSPHRASE;
  process.env.ELIZA_VAULT_DISABLE_KEYCHAIN = "1";
  resetLoadDefaultMasterKeySyncCache();
});

afterEach(() => {
  resetLoadDefaultMasterKeySyncCache();
  if (priorPassphrase === undefined) delete process.env.ELIZA_VAULT_PASSPHRASE;
  else process.env.ELIZA_VAULT_PASSPHRASE = priorPassphrase;
  if (priorDisableKeychain === undefined)
    delete process.env.ELIZA_VAULT_DISABLE_KEYCHAIN;
  else process.env.ELIZA_VAULT_DISABLE_KEYCHAIN = priorDisableKeychain;
});

it("resolves the master key once across repeated sync loads (account-file fan-out)", () => {
  const first = loadDefaultMasterKeySync();
  // Simulate decoding a pool of ~17 credential files in one listAccounts().
  const repeats = Array.from({ length: 17 }, () => loadDefaultMasterKeySync());

  for (const key of repeats) {
    // Same persistent key bytes on every call...
    expect(key.equals(first)).toBe(true);
    // ...AND the exact same cached Buffer instance. An un-memoized resolver
    // (clean develop) re-derives the key per call and returns a fresh Buffer,
    // so reference identity is the bidirectional signal: it holds only when the
    // resolution work happened once for the whole fan-out.
    expect(key).toBe(first);
  }
});



it("still throws on an invalid passphrase before consulting the cache", () => {
  process.env.ELIZA_VAULT_PASSPHRASE = "short";
  expect(() => loadDefaultMasterKeySync()).toThrow(
    /ELIZA_VAULT_PASSPHRASE must be at least/,
  );
});
