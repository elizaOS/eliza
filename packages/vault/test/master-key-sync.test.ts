/**
 * Verifies synchronous boot-time key resolution matches the asynchronous vault resolver without touching a real OS keychain.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  defaultMasterKey,
  loadDefaultMasterKeySync,
  MasterKeyUnavailableError,
} from "../src/master-key.js";

const ORIGINAL_DISABLE_KEYCHAIN = process.env.ELIZA_VAULT_DISABLE_KEYCHAIN;
const ORIGINAL_PASSPHRASE = process.env.ELIZA_VAULT_PASSPHRASE;

afterEach(() => {
  if (ORIGINAL_DISABLE_KEYCHAIN === undefined) {
    delete process.env.ELIZA_VAULT_DISABLE_KEYCHAIN;
  } else {
    process.env.ELIZA_VAULT_DISABLE_KEYCHAIN = ORIGINAL_DISABLE_KEYCHAIN;
  }
  if (ORIGINAL_PASSPHRASE === undefined) {
    delete process.env.ELIZA_VAULT_PASSPHRASE;
  } else {
    process.env.ELIZA_VAULT_PASSPHRASE = ORIGINAL_PASSPHRASE;
  }
});

describe("loadDefaultMasterKeySync", () => {
  it("derives the same persistent key as defaultMasterKey", async () => {
    process.env.ELIZA_VAULT_DISABLE_KEYCHAIN = "1";
    process.env.ELIZA_VAULT_PASSPHRASE = "correct horse battery staple";
    const service = "eliza.sync-master-key-test";

    expect(loadDefaultMasterKeySync({ service })).toEqual(
      await defaultMasterKey({ service }).load(),
    );
  });

  it("rejects weak passphrases before key derivation", () => {
    process.env.ELIZA_VAULT_DISABLE_KEYCHAIN = "1";
    process.env.ELIZA_VAULT_PASSPHRASE = "too-short";

    expect(() => loadDefaultMasterKeySync()).toThrow(MasterKeyUnavailableError);
  });
});
