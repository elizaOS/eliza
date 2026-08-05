/**
 * Optional Solana wallet helpers (live path).
 * Requires @solana/web3.js + bs58 as optional deps.
 */

import type { DflowTradeConfig } from "../config.js";
import type { DflowOrderResponse } from "../client/dflow-client.js";

export type WalletIdentity = {
  publicKey: string;
  hasKey: boolean;
};

export async function loadKeypair(
  privateKeyBase58: string,
): Promise<{ publicKey: string; signAndSend: (order: DflowOrderResponse, rpcUrl: string) => Promise<string> }> {
  let web3: typeof import("@solana/web3.js");
  let bs58: { default: { decode: (s: string) => Uint8Array } };
  try {
    web3 = await import("@solana/web3.js");
    bs58 = (await import("bs58")) as typeof bs58;
  } catch {
    throw new Error(
      "Live trading requires optional deps: bun add @solana/web3.js bs58",
    );
  }

  const secret = bs58.default.decode(privateKeyBase58);
  const keypair = web3.Keypair.fromSecretKey(secret);

  return {
    publicKey: keypair.publicKey.toBase58(),
    signAndSend: async (order, rpcUrl) => {
      if (!order.transaction) {
        throw new Error("order has no transaction — request with userPublicKey");
      }
      const connection = new web3.Connection(rpcUrl, "confirmed");
      const tx = web3.VersionedTransaction.deserialize(
        Buffer.from(order.transaction, "base64"),
      );
      tx.sign([keypair]);
      const sig = await connection.sendTransaction(tx);
      const blockhash = tx.message.recentBlockhash;
      const lastValidBlockHeight = order.lastValidBlockHeight;
      if (lastValidBlockHeight && blockhash) {
        await connection.confirmTransaction(
          {
            signature: sig,
            blockhash,
            lastValidBlockHeight,
          },
          "confirmed",
        );
      } else {
        await connection.confirmTransaction(sig, "confirmed");
      }
      return sig;
    },
  };
}

export async function getSolBalanceLamports(
  rpcUrl: string,
  publicKey: string,
): Promise<number> {
  let web3: typeof import("@solana/web3.js");
  try {
    web3 = await import("@solana/web3.js");
  } catch {
    throw new Error("Balance check requires @solana/web3.js");
  }
  const connection = new web3.Connection(rpcUrl, "confirmed");
  return connection.getBalance(new web3.PublicKey(publicKey));
}

export function assertLiveReady(cfg: DflowTradeConfig): void {
  if (!cfg.liveEnabled) {
    throw new Error(
      "Live trading disabled. Set SOLANA_TRADE_LIVE=true to allow signed swaps.",
    );
  }
  if (!cfg.privateKeyBase58) {
    throw new Error("SOLANA_PRIVATE_KEY (base58) required for live swaps.");
  }
  if (!cfg.rpcUrl) {
    throw new Error("HELIUS_RPC_URL or SOLANA_RPC_URL required for broadcast.");
  }
}
