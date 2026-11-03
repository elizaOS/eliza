import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { LIMITS } from "./limits.ts";
import { liveTradingEnabled, loadWalletSecret, WALLET_PUBKEY_ENV } from "./safety-gate.ts";
import { assertNoValueTransfer, type DecodedInstruction } from "./swap-guard.ts";

export const JUPITER_QUOTE = "https://lite-api.jup.ag/swap/v1/quote";
export const JUPITER_SWAP = "https://lite-api.jup.ag/swap/v1/swap";

export function instructionsFromVersioned(tx: VersionedTransaction): DecodedInstruction[] {
  const keys = tx.message.staticAccountKeys;
  return tx.message.compiledInstructions.map((ix) => {
    const program = keys[ix.programIdIndex];
    if (!program) {
      throw new Error("Refusing a swap whose program id is not in the static account list.");
    }
    return { programId: program.toBase58(), data: Uint8Array.from(ix.data) };
  });
}

export function assertVersionedSwapAllowed(tx: VersionedTransaction): void {
  if (tx.message.addressTableLookups.length > 0) {
    const keys = tx.message.staticAccountKeys;
    for (const ix of tx.message.compiledInstructions) {
      if (ix.programIdIndex >= keys.length) {
        throw new Error("Refusing a swap that hides its program id in an address lookup table.");
      }
    }
  }
  assertNoValueTransfer(instructionsFromVersioned(tx));
}

export interface LiveSwapRequest {
  env: Record<string, string | undefined>;
  side: "buy" | "sell";
  mint: string;
  sol?: number;
  rawAmount?: string;
  fetchImpl?: typeof fetch;
  sendRaw: (base64: string) => Promise<string>;
}

export async function executeLiveSwap(
  request: LiveSwapRequest
): Promise<{ signature: string; outAmount: string }> {
  if (!liveTradingEnabled(request.env)) {
    throw new Error("Live trading is off. No swap was sent.");
  }
  const secret = loadWalletSecret(request.env);
  const owner = request.env[WALLET_PUBKEY_ENV]?.trim();
  if (!owner) throw new Error("Set VALHALLA_PUBKEY to the trader wallet address.");
  const bytes = bs58.decode(secret);
  if (bytes.length !== 64) {
    throw new Error("VALHALLA_WALLET_SECRET_KEY must be a 64-byte base58 secret.");
  }
  const side = request.side;
  const inputMint = side === "buy" ? LIMITS.wsolMint : request.mint;
  const outputMint = side === "buy" ? request.mint : LIMITS.wsolMint;
  const amount =
    side === "buy" ? Math.floor((request.sol ?? 0) * 1e9) : Number(request.rawAmount ?? "0");
  if (!(amount > 0)) throw new Error("Swap amount is empty.");
  const fetchImpl = request.fetchImpl ?? fetch;
  const quoteUrl = new URL(JUPITER_QUOTE);
  quoteUrl.searchParams.set("inputMint", inputMint);
  quoteUrl.searchParams.set("outputMint", outputMint);
  quoteUrl.searchParams.set("amount", String(amount));
  quoteUrl.searchParams.set("slippageBps", "1500");
  const quoteRes = await fetchImpl(quoteUrl.toString());
  if (!quoteRes.ok) throw new Error(`Jupiter quote HTTP ${quoteRes.status}`);
  const quote = (await quoteRes.json()) as { outAmount?: string };
  const swapRes = await fetchImpl(JUPITER_SWAP, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: owner, wrapAndUnwrapSol: true }),
  });
  if (!swapRes.ok) throw new Error(`Jupiter swap HTTP ${swapRes.status}`);
  const swap = (await swapRes.json()) as { swapTransaction?: string };
  if (!swap.swapTransaction) throw new Error("Jupiter did not return a swap transaction.");
  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
  assertVersionedSwapAllowed(tx);
  const keypair = Keypair.fromSecretKey(bytes);
  tx.sign([keypair]);
  const raw = Buffer.from(tx.serialize()).toString("base64");
  const signature = await request.sendRaw(raw);
  return { signature, outAmount: String(quote.outAmount ?? "0") };
}
