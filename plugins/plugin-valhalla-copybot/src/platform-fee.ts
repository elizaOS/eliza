import { PublicKey } from "@solana/web3.js";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { feeDisclosure, readPlatformFee } from "./monetization-trust.ts";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** Token account that Jupiter pays. It is owned by the signed receive address. */
export function feeAccountFor(owner: string, mint: string): string {
  const [ata] = PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), TOKEN_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()],
    ATA_PROGRAM
  );
  return ata.toBase58();
}

export function jupiterQuoteUrl(input: {
  endpoint: string;
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: string;
  platformFeeBps: number;
}): URL {
  const url = new URL(input.endpoint);
  url.searchParams.set("inputMint", input.inputMint);
  url.searchParams.set("outputMint", input.outputMint);
  url.searchParams.set("amount", input.amount);
  url.searchParams.set("slippageBps", input.slippageBps);
  url.searchParams.set("platformFeeBps", String(input.platformFeeBps));
  return url;
}

export function jupiterSwapBody(input: {
  quote: unknown;
  userPublicKey: string;
  feeAccount: string;
}): { quoteResponse: unknown; userPublicKey: string; wrapAndUnwrapSol: true; feeAccount: string } {
  return {
    quoteResponse: input.quote,
    userPublicKey: input.userPublicKey,
    wrapAndUnwrapSol: true,
    feeAccount: input.feeAccount,
  };
}

export function requirePlatformFee(outputMint: string): {
  bps: number;
  receiveAddress: string;
  feeAccount: string;
  line: string;
} {
  const fee = readPlatformFee();
  if (!fee) throw new Error("Platform fee config was not accepted. No swap was sent.");
  const feeAccount = feeAccountFor(fee.receiveAddress, outputMint);
  return { ...fee, feeAccount, line: feeDisclosure(fee.bps) };
}

export async function logFeeIncome(
  dataDir: string,
  row: { signature: string; side: string; mint: string; outAmount: string; bps: number; feeAccount: string }
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, "fee-income.csv");
  const feeBase = (BigInt(row.outAmount || "0") * BigInt(row.bps)) / 10000n;
  const line = [
    new Date().toISOString(),
    row.signature,
    row.side,
    row.mint,
    row.outAmount,
    String(row.bps),
    feeBase.toString(),
    row.feeAccount,
  ].join(",");
  await appendFile(file, `${line}\n`);
}
