// Coordinates cloud service direct wallet payer proof behavior behind route handlers.
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { type Address, getAddress, type Hex, isAddress, verifyTypedData } from "viem";

export type DirectWalletPayerProofNetwork = "base" | "bsc" | "solana";

export type DirectWalletPayerProofScheme = "evm-eip712" | "solana-ed25519";

export const DIRECT_WALLET_PAYER_PROOF_DOMAIN_NAME = "Eliza Cloud Direct Wallet";
export const DIRECT_WALLET_PAYER_PROOF_DOMAIN_VERSION = "1";
export const DIRECT_WALLET_PAYER_PROOF_PRIMARY_TYPE = "DirectWalletPayment";
export const DIRECT_WALLET_PAYER_PROOF_TYPES = {
  DirectWalletPayment: [
    { name: "paymentId", type: "string" },
    { name: "organizationId", type: "string" },
    { name: "userId", type: "string" },
    { name: "network", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "payerAddress", type: "address" },
    { name: "receiveAddress", type: "address" },
    { name: "tokenSymbol", type: "string" },
    { name: "tokenReference", type: "string" },
    { name: "amountUnits", type: "uint256" },
    { name: "nonce", type: "string" },
    { name: "expiresAt", type: "string" },
  ],
} as const;

export interface DirectWalletPayerProofInput {
  paymentId: string;
  organizationId: string;
  userId: string | null;
  network: DirectWalletPayerProofNetwork;
  chainId?: number | null;
  payerAddress: string;
  receiveAddress: string;
  tokenSymbol: string;
  tokenAddress?: string | null;
  tokenMint?: string | null;
  expectedTokenUnits: bigint | string;
  nonce: string;
  expiresAt: Date | string;
}

export interface DirectWalletPayerProofTypedData {
  domain: {
    name: typeof DIRECT_WALLET_PAYER_PROOF_DOMAIN_NAME;
    version: typeof DIRECT_WALLET_PAYER_PROOF_DOMAIN_VERSION;
    chainId: number;
  };
  types: typeof DIRECT_WALLET_PAYER_PROOF_TYPES;
  primaryType: typeof DIRECT_WALLET_PAYER_PROOF_PRIMARY_TYPE;
  message: {
    paymentId: string;
    organizationId: string;
    userId: string;
    network: Exclude<DirectWalletPayerProofNetwork, "solana">;
    chainId: string;
    payerAddress: Address;
    receiveAddress: Address;
    tokenSymbol: string;
    tokenReference: string;
    amountUnits: string;
    nonce: string;
    expiresAt: string;
  };
}

export interface DirectWalletPayerProofSigningTypedData
  extends Omit<DirectWalletPayerProofTypedData, "message"> {
  message: Omit<DirectWalletPayerProofTypedData["message"], "chainId" | "amountUnits"> & {
    chainId: bigint;
    amountUnits: bigint;
  };
}

export type DirectWalletPayerProofVerifyTypedDataParameters =
  DirectWalletPayerProofSigningTypedData & {
    address: Address;
    signature: Hex;
  };

export type DirectWalletPayerProofTypedDataVerifier = (
  params: DirectWalletPayerProofVerifyTypedDataParameters,
) => Promise<boolean>;

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
  return network === "solana" ? "solana-ed25519" : "evm-eip712";
}

function expiresAtIso(expiresAt: Date | string): string {
  return expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt).toISOString();
}

function tokenReference(input: DirectWalletPayerProofInput): string {
  return input.tokenAddress ?? input.tokenMint ?? "native";
}

function amountUnits(input: DirectWalletPayerProofInput): string {
  return typeof input.expectedTokenUnits === "bigint"
    ? input.expectedTokenUnits.toString()
    : input.expectedTokenUnits;
}

export function buildDirectWalletPayerProofMessage(input: DirectWalletPayerProofInput): string {
  return [
    "Eliza Cloud direct wallet payment",
    `Payment ID: ${input.paymentId}`,
    `Organization ID: ${input.organizationId}`,
    `User ID: ${input.userId ?? "none"}`,
    `Network: ${input.network}`,
    `Payer address: ${normalizeDirectWalletPayer(input.network, input.payerAddress)}`,
    `Receive address: ${input.receiveAddress}`,
    `Token: ${input.tokenSymbol}`,
    `Token reference: ${tokenReference(input)}`,
    `Amount units: ${amountUnits(input)}`,
    `Nonce: ${input.nonce}`,
    `Expires at: ${expiresAtIso(input.expiresAt)}`,
  ].join("\n");
}

export function buildDirectWalletPayerProofTypedData(
  input: DirectWalletPayerProofInput & {
    network: Exclude<DirectWalletPayerProofNetwork, "solana">;
    chainId: number;
  },
): DirectWalletPayerProofTypedData {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new Error("Invalid EVM payer proof chain ID");
  }
  return {
    domain: {
      name: DIRECT_WALLET_PAYER_PROOF_DOMAIN_NAME,
      version: DIRECT_WALLET_PAYER_PROOF_DOMAIN_VERSION,
      chainId: input.chainId,
    },
    types: DIRECT_WALLET_PAYER_PROOF_TYPES,
    primaryType: DIRECT_WALLET_PAYER_PROOF_PRIMARY_TYPE,
    message: {
      paymentId: input.paymentId,
      organizationId: input.organizationId,
      userId: input.userId ?? "none",
      network: input.network,
      chainId: String(input.chainId),
      payerAddress: getAddress(input.payerAddress),
      receiveAddress: getAddress(input.receiveAddress),
      tokenSymbol: input.tokenSymbol,
      tokenReference: tokenReference(input),
      amountUnits: amountUnits(input),
      nonce: input.nonce,
      expiresAt: expiresAtIso(input.expiresAt),
    },
  };
}

export function toDirectWalletPayerProofSigningTypedData(
  typedData: DirectWalletPayerProofTypedData,
): DirectWalletPayerProofSigningTypedData {
  return {
    ...typedData,
    message: {
      ...typedData.message,
      chainId: BigInt(typedData.message.chainId),
      amountUnits: BigInt(typedData.message.amountUnits),
    },
  };
}

function typedDataMatchesPayer(args: {
  network: DirectWalletPayerProofNetwork;
  payerAddress: string;
  typedData: DirectWalletPayerProofTypedData;
}): boolean {
  if (args.network === "solana") return false;
  if (args.typedData.domain.name !== DIRECT_WALLET_PAYER_PROOF_DOMAIN_NAME) return false;
  if (args.typedData.domain.version !== DIRECT_WALLET_PAYER_PROOF_DOMAIN_VERSION) return false;
  if (args.typedData.primaryType !== DIRECT_WALLET_PAYER_PROOF_PRIMARY_TYPE) return false;
  if (args.typedData.message.network !== args.network) return false;
  if (String(args.typedData.domain.chainId) !== args.typedData.message.chainId) return false;
  return (
    normalizeEvmPayer(args.typedData.message.payerAddress) === normalizeEvmPayer(args.payerAddress)
  );
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
  message?: string;
  typedData?: DirectWalletPayerProofTypedData;
  signature: string;
  verifyEvmTypedData?: DirectWalletPayerProofTypedDataVerifier;
}): Promise<boolean> {
  try {
    if (args.network === "solana") {
      if (!args.message) return false;
      return verifySolanaPayerSignature({
        payerAddress: args.payerAddress,
        message: args.message,
        signature: args.signature,
      });
    }
    const address = normalizeEvmPayer(args.payerAddress) as `0x${string}`;
    if (!args.signature.startsWith("0x")) return false;
    if (!args.typedData || !typedDataMatchesPayer({ ...args, typedData: args.typedData })) {
      return false;
    }
    const signingTypedData = toDirectWalletPayerProofSigningTypedData(args.typedData);
    const params = {
      address,
      ...signingTypedData,
      signature: args.signature as `0x${string}`,
    };
    if (args.verifyEvmTypedData) return await args.verifyEvmTypedData(params);
    return await verifyTypedData(params);
  } catch {
    return false;
  }
}
