import type { IAgentRuntime } from "@elizaos/core";
import {
  Keypair,
  type PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import type { Hex, TypedDataDefinition } from "viem";
import { hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type {
  SolanaSigner,
  WalletAddresses,
  WalletBackend,
} from "./backend.js";
import {
  SolanaPrivateKeyInvalidError,
  WalletBackendNotConfiguredError,
} from "./errors.js";
import type { SignResult, SignScope } from "./pending.js";

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const v = runtime.getSetting(key);
  if (typeof v === "string" && v.length > 0) {
    return v;
  }
  return undefined;
}

function resolveEvmPrivateKey(runtime: IAgentRuntime): Hex | null {
  const raw =
    readSetting(runtime, "EVM_PRIVATE_KEY") ?? process.env.EVM_PRIVATE_KEY;
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(trimmed)) {
    return null;
  }
  return trimmed as Hex;
}

function keypairFromSolanaSecret(raw: string): Keypair {
  const trimmed = raw.trim();
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(trimmed);
  } catch {
    throw new SolanaPrivateKeyInvalidError(
      "SOLANA_PRIVATE_KEY must be base58-encoded.",
    );
  }
  if (decoded.length === 64) {
    return Keypair.fromSecretKey(decoded);
  }
  if (decoded.length === 32) {
    return Keypair.fromSeed(decoded);
  }
  throw new SolanaPrivateKeyInvalidError(
    "SOLANA_PRIVATE_KEY decodes to an unexpected length (expected 32-byte seed or 64-byte secret key).",
  );
}

function resolveSolanaKeypair(runtime: IAgentRuntime): Keypair | null {
  const raw =
    readSetting(runtime, "SOLANA_PRIVATE_KEY") ??
    process.env.SOLANA_PRIVATE_KEY ??
    readSetting(runtime, "WALLET_PRIVATE_KEY") ??
    process.env.WALLET_PRIVATE_KEY;
  if (!raw) {
    return null;
  }
  try {
    return keypairFromSolanaSecret(raw);
  } catch {
    return null;
  }
}

class LocalSolanaSigner implements SolanaSigner {
  readonly publicKey: PublicKey;

  constructor(private readonly keypair: Keypair) {
    this.publicKey = keypair.publicKey;
  }

  async signTransaction(
    tx: Transaction | VersionedTransaction,
  ): Promise<Transaction | VersionedTransaction> {
    if (tx instanceof Transaction) {
      const serialized = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      const copy = Transaction.from(serialized);
      copy.partialSign(this.keypair);
      return copy;
    }
    const copy = VersionedTransaction.deserialize(tx.serialize());
    copy.sign([this.keypair]);
    return copy;
  }

  async signAllTransactions(
    txs: ReadonlyArray<Transaction | VersionedTransaction>,
  ): Promise<Array<Transaction | VersionedTransaction>> {
    const out: Array<Transaction | VersionedTransaction> = [];
    for (const tx of txs) {
      out.push(await this.signTransaction(tx));
    }
    return out;
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    const nacl = await import("tweetnacl");
    return nacl.default.sign.detached(message, this.keypair.secretKey);
  }
}

/**
 * Desktop default: local EOA / keypair signing. **Does not** autogenerate keys.
 */
export class LocalEoaBackend implements WalletBackend {
  readonly kind = "local" as const;

  private readonly evmAccount: ReturnType<typeof privateKeyToAccount> | null;

  private readonly solanaSigner: SolanaSigner | null;

  private constructor(evmHex: Hex | null, solanaKeypair: Keypair | null) {
    this.evmAccount = evmHex ? privateKeyToAccount(evmHex) : null;
    this.solanaSigner = solanaKeypair
      ? new LocalSolanaSigner(solanaKeypair)
      : null;
  }

  static async create(runtime: IAgentRuntime): Promise<LocalEoaBackend> {
    const evm = resolveEvmPrivateKey(runtime);
    const kp = resolveSolanaKeypair(runtime);
    if (!evm && !kp) {
      throw new WalletBackendNotConfiguredError("NO_WALLET_CONFIGURED");
    }
    return new LocalEoaBackend(evm, kp);
  }

  getAddresses(): WalletAddresses {
    return {
      evm: this.evmAccount?.address ?? null,
      solana: this.solanaSigner?.publicKey ?? null,
    };
  }

  canSign(chainHint: "evm" | "solana" | "off-chain"): boolean {
    if (chainHint === "evm") {
      return this.evmAccount !== null;
    }
    if (chainHint === "solana") {
      return this.solanaSigner !== null;
    }
    return this.evmAccount !== null;
  }

  getEvmAccount(_chainId: number) {
    void _chainId;
    if (!this.evmAccount) {
      throw new WalletBackendNotConfiguredError("EVM_PRIVATE_KEY_MISSING");
    }
    return this.evmAccount;
  }

  getSolanaSigner(): SolanaSigner {
    if (!this.solanaSigner) {
      throw new WalletBackendNotConfiguredError("SOLANA_PRIVATE_KEY_MISSING");
    }
    return this.solanaSigner;
  }

  async signMessage(scope: SignScope, message: Hex): Promise<SignResult> {
    void scope;
    if (!this.evmAccount) {
      throw new WalletBackendNotConfiguredError("EVM_PRIVATE_KEY_MISSING");
    }
    const sig = await this.evmAccount.signMessage({
      message: { raw: hexToBytes(message) },
    });
    return { kind: "signature", signature: sig };
  }

  async signTypedData(
    scope: SignScope,
    typedData: TypedDataDefinition,
  ): Promise<SignResult> {
    void scope;
    if (!this.evmAccount) {
      throw new WalletBackendNotConfiguredError("EVM_PRIVATE_KEY_MISSING");
    }
    const sig = await this.evmAccount.signTypedData(typedData);
    return { kind: "signature", signature: sig };
  }
}
