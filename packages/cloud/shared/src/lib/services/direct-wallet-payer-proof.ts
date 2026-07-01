import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { getAddress, isAddress, verifyMessage } from "viem";

export type DirectWalletPayerProofNetwork = "base" | "bsc" | "solana";

export type DirectWalletPayerProofScheme = "evm-personal-sign" | "solana-ed25519";

export interface DirectWalletPayerProofInput {
  paymentId: string;
  organizationId: string;
  userId: string | null;
  network: DirectWalletPayerProofNetwork;
  payerAddress: string;
  receiveAddress: string;
  tokenSymbol: string;
  tokenAddress?: string | null;
  tokenMint?: string | null;
  expectedTokenUnits: bigint | string;
  expiresAt: Date | string;
}

function normalizeEvmPayer(address: string): string {
  if (!isAddress(address)) throw new Error("Invalid EVM payer address");
  return getAddress(address).toLowerCase();
}

function normalizeSolanaPayer(address: string): string {
  return new PublicKey(address).toBase58();
}

export function normalizeDirectWalletPayer(
  network: DirectWalletPayerProofNetwork,
  address: string,
): string {
  return network === "solana" ? normalizeSolanaPayer(address) : normalizeEvmPayer(address);
}

export function payerProofSchemeForNetwork(
  network: DirectWalletPayerProofNetwork,
): DirectWalletPayerProofScheme {
  return network === "solana" ? "solana-ed25519" : "evm-personal-sign";
}

export function buildDirectWalletPayerProofMessage(input: DirectWalletPayerProofInput): string {
  const expiresAtIso =
    input.expiresAt instanceof Date
      ? input.expiresAt.toISOString()
      : new Date(input.expiresAt).toISOString();
  const tokenRef = input.tokenAddress ?? input.tokenMint ?? "native";
  const units =
    typeof input.expectedTokenUnits === "bigint"
      ? input.expectedTokenUnits.toString()
      : input.expectedTokenUnits;
  return [
    "Eliza Cloud direct wallet payment",
    `Payment ID: ${input.paymentId}`,
    `Organization ID: ${input.organizationId}`,
    `User ID: ${input.userId ?? "none"}`,
    `Network: ${input.network}`,
    `Payer address: ${normalizeDirectWalletPayer(input.network, input.payerAddress)}`,
    `Receive address: ${input.receiveAddress}`,
    `Token: ${input.tokenSymbol}`,
    `Token reference: ${tokenRef}`,
    `Amount units: ${units}`,
    `Expires at: ${expiresAtIso}`,
  ].join("\n");
}

function decodeSolanaSignature(signature: string): Uint8Array {
  try {
    const decoded = bs58.decode(signature);
    if (decoded.length === 64) return decoded;
  } catch {
    // Fall through and try base64/url-safe base64 below.
  }
  const normalized = signature.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.length !== 64) throw new Error("Invalid Solana payer signature");
  return bytes;
}

function verifySolanaPayerSignature(args: {
  payerAddress: string;
  message: string;
  signature: string;
}): boolean {
  const publicKey = new PublicKey(args.payerAddress);
  const messageBytes = new TextEncoder().encode(args.message);
  return nacl.sign.detached.verify(
    messageBytes,
    decodeSolanaSignature(args.signature),
    publicKey.toBytes(),
  );
}

export async function verifyDirectWalletPayerProof(args: {
  network: DirectWalletPayerProofNetwork;
  payerAddress: string;
  message: string;
  signature: string;
}): Promise<boolean> {
  try {
    if (args.network === "solana") {
      return verifySolanaPayerSignature(args);
    }
    const address = normalizeEvmPayer(args.payerAddress) as `0x${string}`;
    if (!args.signature.startsWith("0x")) return false;
    return await verifyMessage({
      address,
      message: args.message,
      signature: args.signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}
