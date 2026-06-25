import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWalletAddresses, syncSolanaPublicKeyEnv } from "./wallet";

/**
 * Regression test for the `PLACEHOLDER_RE is not defined` bug.
 *
 * The sentinel regex was renamed to `ENV_SENTINEL_RE`, but three call sites in
 * `wallet.ts` still referenced the old `PLACEHOLDER_RE` name. Because the
 * package built with `tsc --noCheck`, the undefined identifier was never caught
 * and every one of these wallet-key code paths threw `ReferenceError` at runtime
 * whenever a non-empty key (or any private-key env var) was present.
 *
 * Each assertion below exercises one of the three previously-broken sites: it
 * reaches the sentinel regex with a non-empty value and must return cleanly
 * instead of throwing.
 */
describe("wallet env-sentinel handling (PLACEHOLDER_RE regression)", () => {
  const SAVED = {
    EVM_PRIVATE_KEY: process.env.EVM_PRIVATE_KEY,
    SOLANA_PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY,
  };

  beforeEach(() => {
    delete process.env.EVM_PRIVATE_KEY;
    delete process.env.SOLANA_PRIVATE_KEY;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("syncSolanaPublicKeyEnv treats a sentinel value as unset (line 364 path)", () => {
    // Non-empty sentinel reaches the regex test; must return null, not throw.
    expect(() => syncSolanaPublicKeyEnv("REDACTED")).not.toThrow();
    expect(syncSolanaPublicKeyEnv("REDACTED")).toBeNull();
    expect(syncSolanaPublicKeyEnv("[PLACEHOLDER]")).toBeNull();
    expect(syncSolanaPublicKeyEnv(undefined)).toBeNull();
  });

  it("getWalletAddresses skips sentinel private-key env vars (lines 586/597 path)", () => {
    process.env.EVM_PRIVATE_KEY = "REDACTED";
    process.env.SOLANA_PRIVATE_KEY = "CHANGEME";

    // Before the fix this threw `ReferenceError: PLACEHOLDER_RE is not defined`
    // the moment a non-empty private key was present.
    expect(() => getWalletAddresses()).not.toThrow();

    const addrs = getWalletAddresses();
    // Sentinel keys are not real keys, so no address is derived from them.
    expect(addrs.evmAddress).toBeNull();
    expect(addrs.solanaAddress).toBeNull();
  });
});
