/**
 * A blank SOLANA_* setting (an empty placeholder in a character file's
 * secrets or settings) counts as unset, so the documented WALLET_* fallback
 * still supplies the agent's wallet. Before the fix the empty string
 * shadowed the fallback: the signing path generated and stored a new random
 * keypair, and the read-only lookup reported no wallet. Real AgentRuntime and
 * real SolanaService; no RPC call is made.
 */
import { AgentRuntime } from "@elizaos/core";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { getExistingSolanaPublicKey, getWalletKey } from "./keypairUtils";
import { SolanaService } from "./service";

function runtimeWithSecrets(secrets: Record<string, string>): AgentRuntime {
  return new AgentRuntime({
    character: { name: "WalletAgent", bio: [], secrets },
  });
}

describe("blank SOLANA_* settings fall back to WALLET_*", () => {
  it("signs with WALLET_PRIVATE_KEY when SOLANA_PRIVATE_KEY is blank", async () => {
    const configured = Keypair.generate();
    const runtime = runtimeWithSecrets({
      SOLANA_PRIVATE_KEY: "",
      WALLET_PRIVATE_KEY: bs58.encode(configured.secretKey),
      SOLANA_RPC_URL: "http://127.0.0.1:1",
    });

    const keypair = await new SolanaService(runtime).getWalletKeypair();

    expect(keypair.publicKey.toBase58()).toBe(configured.publicKey.toBase58());
    // No replacement wallet was generated and written over the settings.
    expect(runtime.getSetting("SOLANA_PRIVATE_KEY")).toBe("");
    expect(runtime.getSetting("SOLANA_PUBLIC_KEY")).toBeNull();
  });

  it("reports WALLET_PUBLIC_KEY when SOLANA_PUBLIC_KEY is blank", async () => {
    const configured = Keypair.generate();
    const runtime = runtimeWithSecrets({
      SOLANA_PUBLIC_KEY: "",
      WALLET_PUBLIC_KEY: configured.publicKey.toBase58(),
    });

    expect(getExistingSolanaPublicKey(runtime)?.toBase58()).toBe(configured.publicKey.toBase58());
    const { publicKey } = await getWalletKey(runtime, false);
    expect(publicKey?.toBase58()).toBe(configured.publicKey.toBase58());
    expect(runtime.getSetting("SOLANA_PRIVATE_KEY")).toBeNull();
  });

  it("still generates a wallet when no key is configured at all", async () => {
    const runtime = runtimeWithSecrets({ SOLANA_PRIVATE_KEY: "" });

    const { keypair } = await getWalletKey(runtime, true);

    expect(keypair).toBeDefined();
    expect(runtime.getSetting("SOLANA_PUBLIC_KEY")).toBe(keypair?.publicKey.toBase58());
  });
});
