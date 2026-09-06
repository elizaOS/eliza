import { NETWORK, TEST_NETWORK, Transaction } from "@scure/btc-signer";
import type { BTC_NETWORK } from "@scure/btc-signer/utils.js";
import { pubECDSA, pubSchnorr } from "@scure/btc-signer/utils.js";

import type {
  BitcoinAddressType,
  BitcoinNetwork,
  WalletAddressMetadata,
} from "../../shared/src/index.ts";

export interface BitcoinPsbtSigningMetadata {
  network: BitcoinNetwork;
  addressType: BitcoinAddressType;
  publicKey: string;
  xOnlyPublicKey?: string;
}

export interface SignBitcoinPsbtOptions {
  psbtBase64: string;
  privateKey: string;
  walletMetadata: WalletAddressMetadata;
  finalize?: boolean;
}

export interface SignBitcoinPsbtResult {
  signedPsbtBase64: string;
  signedInputs: number;
  addressType: BitcoinAddressType;
  network: BitcoinNetwork;
  finalizedTxHex?: string;
  txId?: string;
  vsize?: number;
  feeSats?: string;
}

export interface BitcoinPsbtOutput {
  index: number;
  address: string;
  amountSats: string;
}

export interface BitcoinPsbtInspection {
  outputs: BitcoinPsbtOutput[];
  inputTotalSats: string;
  outputTotalSats: string;
  feeSats: string;
}

export function parseBitcoinPsbtSigningMetadata(
  metadata: WalletAddressMetadata,
): BitcoinPsbtSigningMetadata {
  const bitcoin = metadata.bitcoin;
  if (!bitcoin || typeof bitcoin !== "object") {
    throw new Error("Bitcoin wallet metadata is required for PSBT signing");
  }
  if (bitcoin.network !== "mainnet" && bitcoin.network !== "testnet") {
    throw new Error("Unsupported Bitcoin wallet network");
  }
  if (bitcoin.addressType !== "p2wpkh" && bitcoin.addressType !== "p2tr") {
    throw new Error("Unsupported Bitcoin wallet address type");
  }
  if (!isHexBytes(bitcoin.publicKey, 33)) {
    throw new Error("Bitcoin wallet metadata publicKey is malformed");
  }
  if (
    bitcoin.addressType === "p2tr" &&
    !isHexBytes(bitcoin.xOnlyPublicKey, 32)
  ) {
    throw new Error(
      "Bitcoin Taproot wallet metadata xOnlyPublicKey is malformed",
    );
  }
  return {
    network: bitcoin.network,
    addressType: bitcoin.addressType,
    publicKey: bitcoin.publicKey,
    xOnlyPublicKey: bitcoin.xOnlyPublicKey,
  };
}

export function signBitcoinPsbt({
  psbtBase64,
  privateKey,
  walletMetadata,
  finalize = false,
}: SignBitcoinPsbtOptions): SignBitcoinPsbtResult {
  const metadata = parseBitcoinPsbtSigningMetadata(walletMetadata);
  const privateKeyBytes = decodePrivateKey(privateKey);
  assertPrivateKeyMatchesMetadata(privateKeyBytes, metadata);

  const tx = parsePsbt(psbtBase64);

  let signedInputs: number;
  try {
    signedInputs = tx.sign(privateKeyBytes);
  } catch (error) {
    if (errorMessage(error).includes("No inputs signed")) {
      throw new Error(
        "Bitcoin PSBT does not contain inputs spendable by this wallet",
      );
    }
    throw new Error(`Bitcoin PSBT signing failed: ${errorMessage(error)}`);
  }
  if (signedInputs < 1) {
    throw new Error(
      "Bitcoin PSBT does not contain inputs spendable by this wallet",
    );
  }

  const result: SignBitcoinPsbtResult = {
    signedPsbtBase64: encodeBase64(tx.toPSBT()),
    signedInputs,
    addressType: metadata.addressType,
    network: metadata.network,
  };
  if (!finalize) return result;

  try {
    tx.finalize();
    tx.extract();
  } catch (error) {
    throw new Error(`Bitcoin PSBT finalization failed: ${errorMessage(error)}`);
  }

  return {
    ...result,
    signedPsbtBase64: encodeBase64(tx.toPSBT()),
    finalizedTxHex: tx.hex,
    txId: tx.id,
    vsize: tx.vsize,
    feeSats: tx.fee.toString(),
  };
}

export function extractBitcoinPsbtOutputs(
  psbtBase64: string,
  walletMetadata: WalletAddressMetadata,
): BitcoinPsbtOutput[] {
  return inspectBitcoinPsbt(psbtBase64, walletMetadata).outputs;
}

export function inspectBitcoinPsbt(
  psbtBase64: string,
  walletMetadata: WalletAddressMetadata,
): BitcoinPsbtInspection {
  const metadata = parseBitcoinPsbtSigningMetadata(walletMetadata);
  const tx = parsePsbt(psbtBase64);
  const network = bitcoinSignerNetwork(metadata.network);
  const outputs: BitcoinPsbtOutput[] = [];
  let outputTotal = 0n;
  for (let index = 0; index < tx.outputsLength; index++) {
    const output = tx.getOutput(index);
    if (output.amount === undefined) {
      throw new Error(`Bitcoin PSBT output ${index} is missing an amount`);
    }
    outputTotal += output.amount;
    const address = tx.getOutputAddress(index, network);
    if (!address) {
      throw new Error(
        `Bitcoin PSBT output ${index} does not contain a standard address`,
      );
    }
    outputs.push({ index, address, amountSats: output.amount.toString() });
  }

  let fee: bigint;
  try {
    fee = tx.fee;
  } catch (error) {
    throw new Error(
      `Bitcoin PSBT input amounts are required for fee policy: ${errorMessage(error)}`,
    );
  }
  if (fee < 0n) {
    throw new Error("Bitcoin PSBT outputs spend more than input amounts");
  }

  return {
    outputs,
    inputTotalSats: (outputTotal + fee).toString(),
    outputTotalSats: outputTotal.toString(),
    feeSats: fee.toString(),
  };
}

function parsePsbt(psbtBase64: string): Transaction {
  const psbtBytes = decodeBase64(psbtBase64);
  try {
    return Transaction.fromPSBT(psbtBytes, {
      allowLegacyWitnessUtxo: false,
      allowUnknownOutputs: false,
      allowUnknownInputs: false,
    });
  } catch (error) {
    throw new Error(`Malformed Bitcoin PSBT: ${errorMessage(error)}`);
  }
}

function bitcoinSignerNetwork(network: BitcoinNetwork): BTC_NETWORK {
  return network === "mainnet" ? NETWORK : TEST_NETWORK;
}

function assertPrivateKeyMatchesMetadata(
  privateKey: Uint8Array,
  metadata: BitcoinPsbtSigningMetadata,
): void {
  const publicKey = encodeHex0x(pubECDSA(privateKey));
  if (publicKey !== metadata.publicKey.toLowerCase()) {
    throw new Error(
      "Bitcoin private key does not match wallet metadata publicKey",
    );
  }
  if (metadata.addressType === "p2tr") {
    const xOnlyPublicKey = encodeHex0x(pubSchnorr(privateKey));
    if (xOnlyPublicKey !== metadata.xOnlyPublicKey?.toLowerCase()) {
      throw new Error(
        "Bitcoin private key does not match wallet metadata xOnlyPublicKey",
      );
    }
  }
}

function decodePrivateKey(privateKey: string): Uint8Array {
  if (!isHexBytes(privateKey, 32)) {
    throw new Error("Bitcoin private key must be a 32-byte hex string");
  }
  return decodeHex(privateKey.slice(2));
}

function isHexBytes(value: unknown, bytes: number): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)
  );
}

function decodeHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function encodeHex0x(bytes: Uint8Array): `0x${string}` {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out as `0x${string}`;
}

function decodeBase64(value: string): Uint8Array {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("PSBT must be a non-empty base64 string");
  }
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch (error) {
    throw new Error(`PSBT base64 decoding failed: ${errorMessage(error)}`);
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
