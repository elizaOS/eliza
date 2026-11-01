/**
 * `solanaClient.loadWallet` is the LP subsystem's Solana signer loader. It
 * must accept the same key settings as every other wallet loader in the
 * plugin (`SOLANA_PRIVATE_KEY` with the documented `WALLET_PRIVATE_KEY`
 * alias, matching `keypairUtils.getWalletKey` and `LocalEoaBackend`), with
 * `SOLANA_PRIVATE_KEY` keeping precedence. A `WALLET_PRIVATE_KEY`-only agent
 * must not lose LP deposit/withdraw signing when transfers and swaps work.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { getWalletPrivateKey, loadWallet } from "./solanaClient";

const KEYPAIR_A = Keypair.generate();
const KEYPAIR_B = Keypair.generate();
const SECRET_A = bs58.encode(KEYPAIR_A.secretKey);
const SECRET_B = bs58.encode(KEYPAIR_B.secretKey);

function stubRuntime(settings: Record<string, string>): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key] ?? null,
  } as unknown as IAgentRuntime;
}

describe("solanaClient wallet key resolution", () => {
  it("getWalletPrivateKey falls back to the WALLET_PRIVATE_KEY alias", () => {
    expect(
      getWalletPrivateKey(stubRuntime({ WALLET_PRIVATE_KEY: SECRET_A })),
    ).toBe(SECRET_A);
    expect(getWalletPrivateKey(stubRuntime({}))).toBeNull();
  });

  it("loadWallet signs with WALLET_PRIVATE_KEY when SOLANA_PRIVATE_KEY is unset", async () => {
    const wallet = await loadWallet(
      stubRuntime({ WALLET_PRIVATE_KEY: SECRET_A }),
      true,
    );
    expect(wallet.address.toBase58()).toBe(KEYPAIR_A.publicKey.toBase58());
    expect(wallet.signer).toBeDefined();
  });

  it("loadWallet keeps SOLANA_PRIVATE_KEY precedence over the alias", async () => {
    const wallet = await loadWallet(
      stubRuntime({
        SOLANA_PRIVATE_KEY: SECRET_A,
        WALLET_PRIVATE_KEY: SECRET_B,
      }),
      true,
    );
    expect(wallet.address.toBase58()).toBe(KEYPAIR_A.publicKey.toBase58());
  });

  it("loadWallet resolves the address from the WALLET_PUBLIC_KEY alias", async () => {
    const wallet = await loadWallet(
      stubRuntime({
        WALLET_PUBLIC_KEY: KEYPAIR_B.publicKey.toBase58(),
      }),
      false,
    );
    expect(wallet.address.toBase58()).toBe(KEYPAIR_B.publicKey.toBase58());
    expect(wallet.signer).toBeUndefined();
  });
});
