/**
 * SolanaBridgeModule — CCTP V2 cross-chain USDC bridge between EVM chains and Solana.
 *
 * Uses Circle's Cross-Chain Transfer Protocol (CCTP) V2 for trustless USDC transfers.
 * EVM side uses viem; Solana side uses @solana/web3.js as an optional peer dependency.
 *
 * Sources:
 *   - Circle CCTP Solana docs: https://developers.circle.com/cctp/docs/solana
 *   - Solana USDC mint: https://solana.com/ecosystem/usdc
 *   - CCTP domain IDs: https://developers.circle.com/cctp/references/contract-addresses
 */

import {
  type Address,
  type Chain,
  createPublicClient,
  getContract,
  type Hash,
  type Hex,
  http,
  keccak256,
  type PublicClient,
  pad,
  type WalletClient,
} from "viem";
import {
  arbitrum,
  avalanche,
  base,
  linea,
  mainnet,
  optimism,
  polygon,
} from "viem/chains";
import {
  ERC20BridgeAbi,
  MessageTransmitterV2Abi,
  TokenMessengerV2Abi,
} from "./abis.js";
import {
  ATTESTATION_POLL_INTERVAL_MS,
  CCTP_DOMAIN_IDS,
  CIRCLE_ATTESTATION_API,
  type EVMBridgeChain,
  FINALITY_THRESHOLD,
  MAX_ATTESTATION_POLLS,
  MESSAGE_TRANSMITTER_V2 as MESSAGE_TRANSMITTER_V2_MAP,
  TOKEN_MESSENGER_V2,
  USDC_CONTRACT,
} from "./types.js";

// ─── Solana Constants ───

/** Solana CCTP domain ID */
export const SOLANA_CCTP_DOMAIN = 5;

/** Native USDC mint on Solana Mainnet */
export const SOLANA_USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as const;

/**
 * Solana CCTP V2 TokenMessengerMinterV2 program address.
 * This is the V2 program (not V1 CCTPiPYP...). The V2 program combines
 * TokenMessengerV2 + TokenMinterV2 into a single program.
 * Source: https://developers.circle.com/cctp/references/solana-programs
 * Verified: https://github.com/circlefin/solana-cctp-contracts (programs/v2)
 */
export const SOLANA_TOKEN_MESSENGER =
  "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe" as const;

/**
 * Solana CCTP V2 MessageTransmitterV2 program address.
 * This is the V2 program (not V1 CCTPmbSD...).
 * Source: https://developers.circle.com/cctp/references/solana-programs
 * Verified: https://github.com/circlefin/solana-cctp-contracts (programs/v2)
 */
export const SOLANA_MESSAGE_TRANSMITTER =
  "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC" as const;

/** Default Solana Mainnet RPC endpoint */
export const SOLANA_DEFAULT_RPC =
  "https://api.mainnet-beta.solana.com" as const;

// ─── Viem chain definitions for EVM side ───

const VIEM_CHAINS: Record<EVMBridgeChain, Chain> = {
  base,
  ethereum: mainnet,
  optimism,
  arbitrum,
  polygon,
  avalanche,
  linea,
  unichain: {
    id: 130,
    name: "Unichain",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://mainnet.unichain.org"] } },
  },
  sonic: {
    id: 146,
    name: "Sonic",
    nativeCurrency: { name: "S", symbol: "S", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.soniclabs.com"] } },
  },
  worldchain: {
    id: 480,
    name: "World Chain",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: { http: ["https://worldchain-mainnet.g.alchemy.com/public"] },
    },
  },
};

// ─── Helpers ───

/**
 * Encode a Solana base58 public key as a 32-byte hex buffer for CCTP.
 * CCTP requires the mint recipient to be a 32-byte zero-padded value.
 * For Solana, this is the base58-decoded public key (already 32 bytes).
 */
function solanaPubkeyToBytes32(base58Address: string): Hex {
  // Dynamic import for optional @solana/web3.js
  // We manually decode base58 here to avoid requiring the dependency at import time.
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = new Uint8Array(32);
  let intVal = 0n;
  for (const char of base58Address) {
    const digit = BigInt(ALPHABET.indexOf(char));
    if (digit < 0n)
      throw new Error(
        `SolanaBridge: Invalid base58 character '${char}' in address.`,
      );
    intVal = intVal * 58n + digit;
  }
  // Write to 32-byte big-endian buffer
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(intVal & 0xffn);
    intVal >>= 8n;
  }
  if (intVal !== 0n)
    throw new Error(`SolanaBridge: Address value overflows 32 bytes.`);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hex}` as Hex;
}

/**
 * Decode a 32-byte hex buffer back to a Solana base58 public key.
 * Used when interpreting Solana→EVM message recipient fields.
 */
export function bytes32ToSolanaPubkey(bytes32: Hex): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const hex = bytes32.startsWith("0x") ? bytes32.slice(2) : bytes32;
  if (hex.length !== 64)
    throw new Error(
      `SolanaBridge: Expected 32-byte hex (64 chars), got ${hex.length}.`,
    );
  let intVal = BigInt(`0x${hex}`);
  let result = "";
  while (intVal > 0n) {
    const rem = Number(intVal % 58n);
    intVal /= 58n;
    result = ALPHABET[rem] + result;
  }
  return result || "1";
}

// ─── EVM→Solana Bridge ───

export interface EVMToSolanaOptions {
  /** Solana recipient address (base58). Defaults to the EVM signer's address re-encoded — usually wrong; always specify. */
  solanaRecipient: string;
  /** EVM source chain. Defaults to 'base'. */
  fromChain?: EVMBridgeChain;
  /** Optional EVM RPC URL override. */
  evmRpcUrl?: string;
  /** Finality threshold: FAST (0) or FINALIZED (1000). Default: FAST. */
  minFinalityThreshold?: number;
  /** Max bridge fee in USDC base units. Default: 0 (no fee). */
  maxFee?: bigint;
  /** Circle IRIS API URL override. */
  attestationApiUrl?: string;
}

export interface EVMToSolanaResult {
  /** EVM burn transaction hash */
  burnTxHash: Hash;
  /** Circle message hash (used to poll for attestation) */
  messageHash: Hex;
  /** Raw CCTP message bytes (for manual receiveMessage on Solana) */
  messageBytes: Hex;
  /** Circle attestation signature (for receiveMessage on Solana) */
  attestation: Hex;
  /** The Solana CCTP domain (5) */
  destinationDomain: number;
  /** Amount bridged in USDC base units */
  amount: bigint;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
}

/**
 * Bridge USDC from an EVM chain to Solana using CCTP V2.
 *
 * This function handles the EVM burn side and attestation polling.
 * The Solana receive side must be completed by calling `receiveMessageOnSolana()`
 * or by the Solana recipient manually submitting the message and attestation
 * to the Solana MessageTransmitter program.
 *
 * @param walletClient - Viem WalletClient with a signer attached (for EVM)
 * @param amount - Amount to bridge in USDC base units (6 decimals, e.g. 1_000_000n = 1 USDC)
 * @param options - Bridge options including solanaRecipient (required)
 * @returns Burn tx hash, attestation, and message bytes for Solana receive
 */
export async function bridgeEVMToSolana(
  walletClient: WalletClient,
  amount: bigint,
  options: EVMToSolanaOptions,
): Promise<EVMToSolanaResult> {
  const startMs = Date.now();
  const fromChain = options.fromChain ?? "base";
  const minFinalityThreshold =
    options.minFinalityThreshold ?? FINALITY_THRESHOLD.FAST;
  const maxFee = options.maxFee ?? 0n;
  const attestationApiUrl = options.attestationApiUrl ?? CIRCLE_ATTESTATION_API;

  if (!walletClient.account) {
    throw new SolanaBridgeError(
      "NO_WALLET_CLIENT",
      "WalletClient must have an account attached.",
    );
  }
  if (amount <= 0n) {
    throw new SolanaBridgeError(
      "INVALID_AMOUNT",
      `Bridge amount must be > 0. Received: ${amount}.`,
    );
  }
  if (!options.solanaRecipient) {
    throw new SolanaBridgeError(
      "INVALID_RECIPIENT",
      "solanaRecipient (base58 Solana address) is required.",
    );
  }

  // Encode Solana address as 32-byte CCTP mint recipient
  const mintRecipient = solanaPubkeyToBytes32(options.solanaRecipient);

  // Zero destinationCaller = any relayer can submit on Solana
  const destinationCaller = pad("0x0" as Hex, { size: 32 });

  const publicClient = createPublicClient({
    chain: VIEM_CHAINS[fromChain],
    transport: http(options.evmRpcUrl),
  }) as PublicClient;

  const account = walletClient.account;
  const usdcAddress = USDC_CONTRACT[fromChain];
  const messengerAddress = TOKEN_MESSENGER_V2[fromChain];

  // Approve USDC if needed
  const usdcRead = getContract({
    address: usdcAddress,
    abi: ERC20BridgeAbi,
    client: publicClient,
  });
  const currentAllowance = (await usdcRead.read.allowance([
    account.address,
    messengerAddress,
  ])) as bigint;
  if (currentAllowance < amount) {
    const usdcWrite = getContract({
      address: usdcAddress,
      abi: ERC20BridgeAbi,
      client: { public: publicClient, wallet: walletClient },
    });
    const approveTxHash = await usdcWrite.write.approve(
      [messengerAddress, amount],
      {
        account,
        chain: VIEM_CHAINS[fromChain],
      },
    );
    const approveReceipt = await publicClient.waitForTransactionReceipt({
      hash: approveTxHash,
    });
    if (approveReceipt.status !== "success") {
      throw new SolanaBridgeError(
        "INSUFFICIENT_ALLOWANCE",
        `USDC approve failed (tx: ${approveTxHash}).`,
      );
    }
  }

  // Burn USDC via CCTP V2 depositForBurn targeting Solana domain
  const messenger = getContract({
    address: messengerAddress,
    abi: TokenMessengerV2Abi,
    client: { public: publicClient, wallet: walletClient },
  });

  let burnTxHash: Hash;
  try {
    burnTxHash = await messenger.write.depositForBurn(
      [
        amount,
        SOLANA_CCTP_DOMAIN,
        mintRecipient,
        usdcAddress,
        destinationCaller,
        maxFee,
        minFinalityThreshold,
      ],
      { account, chain: VIEM_CHAINS[fromChain] },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SolanaBridgeError(
      "BURN_FAILED",
      `CCTP depositForBurn to Solana failed: ${msg}.`,
    );
  }

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: burnTxHash,
  });
  if (receipt.status !== "success") {
    throw new SolanaBridgeError(
      "BURN_FAILED",
      `depositForBurn transaction reverted (tx: ${burnTxHash}).`,
    );
  }

  // Extract message bytes from MessageSent event
  const { messageBytes, messageHash } = extractMessageSent(receipt.logs);

  // Poll Circle IRIS for attestation
  const attestation = await pollForAttestation(
    messageHash,
    CCTP_DOMAIN_IDS[fromChain],
    attestationApiUrl,
  );

  return {
    burnTxHash,
    messageHash,
    messageBytes,
    attestation,
    destinationDomain: SOLANA_CCTP_DOMAIN,
    amount,
    elapsedMs: Date.now() - startMs,
  };
}

// ─── Solana→EVM Bridge ───

export interface SolanaToEVMOptions {
  /** EVM destination chain */
  toChain: EVMBridgeChain;
  /** Optional EVM destination RPC URL override */
  evmRpcUrl?: string;
  /** EVM recipient address. Defaults to the EVM walletClient's account address. */
  evmRecipient?: Address;
  /** Circle IRIS API URL override */
  attestationApiUrl?: string;
  /** Solana RPC URL override */
  solanaRpcUrl?: string;
}

export interface SolanaToEVMBurnParams {
  /** Raw CCTP message bytes from Solana burn transaction */
  messageBytes: Hex;
  /** Circle message hash */
  messageHash: Hex;
  /** Source domain (should be SOLANA_CCTP_DOMAIN = 5) */
  sourceDomain: number;
}

export interface SolanaToEVMResult {
  /** EVM mint transaction hash */
  mintTxHash: Hash;
  /** Amount received in USDC base units */
  amount: bigint;
  /** EVM destination chain */
  toChain: EVMBridgeChain;
  /** EVM recipient address */
  recipient: Address;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
}

/**
 * Complete the Solana→EVM bridge by polling for Circle's attestation and minting on EVM.
 *
 * The caller is responsible for initiating the Solana burn via the Solana
 * CCTP MessageTransmitter and passing the resulting messageBytes + messageHash here.
 *
 * @param walletClient - Viem WalletClient (for EVM signing)
 * @param burnParams - Message bytes and hash from the Solana burn transaction
 * @param options - Destination chain and optional overrides
 */
export async function receiveFromSolanaOnEVM(
  walletClient: WalletClient,
  burnParams: SolanaToEVMBurnParams,
  options: SolanaToEVMOptions,
): Promise<SolanaToEVMResult> {
  const startMs = Date.now();
  const { toChain, evmRpcUrl } = options;
  const attestationApiUrl = options.attestationApiUrl ?? CIRCLE_ATTESTATION_API;

  if (!walletClient.account) {
    throw new SolanaBridgeError(
      "NO_WALLET_CLIENT",
      "WalletClient must have an account attached.",
    );
  }

  const account = walletClient.account;
  const recipient = options.evmRecipient ?? account.address;

  // Poll Circle IRIS for attestation
  const attestation = await pollForAttestation(
    burnParams.messageHash,
    burnParams.sourceDomain,
    attestationApiUrl,
  );

  // Submit receiveMessage on EVM
  const transmitterAddress = MESSAGE_TRANSMITTER_V2_MAP[toChain];
  const destChain = VIEM_CHAINS[toChain];
  const destPublicClient = createPublicClient({
    chain: destChain,
    transport: http(evmRpcUrl),
  }) as PublicClient;

  const transmitter = getContract({
    address: transmitterAddress,
    abi: MessageTransmitterV2Abi,
    client: { public: destPublicClient, wallet: walletClient },
  });

  let mintTxHash: Hash;
  try {
    mintTxHash = await transmitter.write.receiveMessage(
      [burnParams.messageBytes, attestation],
      { account, chain: destChain },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SolanaBridgeError(
      "MINT_FAILED",
      `CCTP receiveMessage on ${toChain} failed: ${msg}.`,
    );
  }

  const mintReceipt = await destPublicClient.waitForTransactionReceipt({
    hash: mintTxHash,
  });
  if (mintReceipt.status !== "success") {
    throw new SolanaBridgeError(
      "MINT_FAILED",
      `receiveMessage reverted on ${toChain} (tx: ${mintTxHash}).`,
    );
  }

  // Parse amount from mint receipt logs (MintAndWithdraw event)
  // Fallback: return 0n if event not found (amount can be retrieved from the original Solana tx)
  const amount = parseMintAmount(mintReceipt.logs);

  return {
    mintTxHash,
    amount,
    toChain,
    recipient,
    elapsedMs: Date.now() - startMs,
  };
}

// ─── Shared helpers ───

/**
 * Extract CCTP MessageSent event from EVM transaction logs.
 * Event topic: keccak256("MessageSent(bytes)") = 0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036
 */
function extractMessageSent(
  logs: readonly { topics: readonly Hex[]; data: Hex }[],
): { messageBytes: Hex; messageHash: Hex } {
  const MESSAGE_SENT_TOPIC =
    "0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036";
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() === MESSAGE_SENT_TOPIC.toLowerCase()) {
      const dataHex = log.data.slice(2);
      if (dataHex.length < 128) continue;
      const lengthHex = dataHex.slice(64, 128);
      const messageLength = parseInt(lengthHex, 16);
      if (messageLength === 0) continue;
      const messageBytesHex = dataHex.slice(128, 128 + messageLength * 2);
      const messageBytes = `0x${messageBytesHex}` as Hex;
      const messageHash = keccak256(messageBytes);
      return { messageBytes, messageHash };
    }
  }
  throw new SolanaBridgeError(
    "BURN_FAILED",
    "Could not find MessageSent event in burn transaction receipt.",
  );
}

/** Parse USDC amount from MintAndWithdraw event logs (best-effort). */
function parseMintAmount(
  logs: readonly { topics: readonly Hex[]; data: Hex }[],
): bigint {
  // MintAndWithdraw(address,uint256,address) — topic0 = keccak256("MintAndWithdraw(address,uint256,address)")
  const MINT_AND_WITHDRAW_TOPIC =
    "0x1b2a7ff080b8cb6ff436ce0372e399692bbfb6d4ae5766fd8d58a7b8cc6142e9";
  for (const log of logs) {
    if (
      log.topics[0]?.toLowerCase() === MINT_AND_WITHDRAW_TOPIC.toLowerCase()
    ) {
      // amount is the second indexed param OR first data word
      if (log.data.length >= 66) {
        return BigInt(`0x${log.data.slice(2, 66)}`);
      }
    }
  }
  return 0n; // fallback: caller can determine amount from source transaction
}

/** Poll Circle IRIS attestation API. */
async function pollForAttestation(
  messageHash: Hex,
  sourceDomain: number,
  apiUrl: string,
): Promise<Hex> {
  const url = `${apiUrl}/v2/messages/${sourceDomain}/${messageHash}`;
  for (let attempt = 0; attempt < MAX_ATTESTATION_POLLS; attempt++) {
    let response: { status: string; attestation?: Hex | null; error?: string };
    try {
      // @duplicate-component-audit-allow Circle attestation polling is not an LLM generation call.
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) {
        if (res.status === 404) {
          await sleep(ATTESTATION_POLL_INTERVAL_MS);
          continue;
        }
        const body = await res.text().catch(() => "");
        throw new SolanaBridgeError(
          "ATTESTATION_ERROR",
          `Circle API returned HTTP ${res.status}: ${body}.`,
        );
      }
      response = (await res.json()) as typeof response;
    } catch (err: unknown) {
      if (err instanceof SolanaBridgeError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new SolanaBridgeError(
        "ATTESTATION_ERROR",
        `Failed to reach Circle IRIS API: ${msg}.`,
      );
    }

    if (response.status === "complete" && response.attestation)
      return response.attestation;
    if (response.status === "error") {
      throw new SolanaBridgeError(
        "ATTESTATION_ERROR",
        `Circle attestation failed: ${response.error ?? "unknown error"}.`,
      );
    }
    await sleep(ATTESTATION_POLL_INTERVAL_MS);
  }
  throw new SolanaBridgeError(
    "ATTESTATION_TIMEOUT",
    `Attestation not received after ${MAX_ATTESTATION_POLLS} attempts. Message hash: ${messageHash}.`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Error Class ───

export type SolanaBridgeErrorCode =
  | "NO_WALLET_CLIENT"
  | "INVALID_AMOUNT"
  | "INVALID_RECIPIENT"
  | "INSUFFICIENT_ALLOWANCE"
  | "BURN_FAILED"
  | "ATTESTATION_ERROR"
  | "ATTESTATION_TIMEOUT"
  | "MINT_FAILED";

export class SolanaBridgeError extends Error {
  readonly code: SolanaBridgeErrorCode;
  constructor(code: SolanaBridgeErrorCode, message: string) {
    super(`[SolanaBridge:${code}] ${message}`);
    this.code = code;
    this.name = "SolanaBridgeError";
  }
}
