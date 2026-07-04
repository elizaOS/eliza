/**
 * Unit tests for `LocalEoaBackend.create` key resolution. Exercises the real
 * key-derivation path (no mocked signer): a valid base58 Solana secret yields a
 * usable signer, and — critically — a configured-but-malformed key surfaces the
 * typed `SolanaPrivateKeyInvalidError` instead of being swallowed into a null
 * that reads identically to "no wallet configured".
 */
import type { IAgentRuntime } from "@elizaos/core";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SolanaPrivateKeyInvalidError,
  WalletBackendNotConfiguredError,
} from "./errors";
import { LocalEoaBackend } from "./local-eoa-backend";

const KEY_ENV_VARS = [
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "WALLET_PRIVATE_KEY",
];

function runtimeWith(
  settings: Record<string, string | undefined>,
): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

describe("LocalEoaBackend.create — Solana key resolution", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // The resolver falls back to process.env; clear the wallet keys so the
    // test's runtime.getSetting is the sole source of truth.
    for (const name of KEY_ENV_VARS) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of KEY_ENV_VARS) {
      if (savedEnv[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = savedEnv[name];
      }
    }
  });

  it("derives a Solana signer from a valid base58 secret", async () => {
    const kp = Keypair.generate();
    const secret = bs58.encode(kp.secretKey);
    const backend = await LocalEoaBackend.create(
      runtimeWith({ SOLANA_PRIVATE_KEY: secret }),
    );
    expect(String(backend.getAddresses().solana)).toBe(kp.publicKey.toBase58());
    expect(backend.canSign("solana")).toBe(true);
  });

  it("surfaces a malformed configured key instead of masking it as 'no wallet'", async () => {
    // A configured key that decodes to the wrong length is a misconfiguration:
    // it must throw the typed invalid-key error, never fall through to
    // WalletBackendNotConfiguredError (which means "no key was configured").
    const wrongLength = bs58.encode(new Uint8Array(48));
    await expect(
      LocalEoaBackend.create(runtimeWith({ SOLANA_PRIVATE_KEY: wrongLength })),
    ).rejects.toBeInstanceOf(SolanaPrivateKeyInvalidError);
  });

  it("surfaces a non-base58 configured key as a typed invalid-key error", async () => {
    await expect(
      LocalEoaBackend.create(
        runtimeWith({ SOLANA_PRIVATE_KEY: "not valid base58 !!!" }),
      ),
    ).rejects.toBeInstanceOf(SolanaPrivateKeyInvalidError);
  });

  it("still reports NO_WALLET_CONFIGURED when genuinely no key is set", async () => {
    await expect(
      LocalEoaBackend.create(runtimeWith({})),
    ).rejects.toBeInstanceOf(WalletBackendNotConfiguredError);
  });
});
