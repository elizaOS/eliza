/**
 * @module tokens/solana
 * Solana SPL token support for AgentWallet v6.
 *
 * Uses @solana/web3.js as an optional peer dependency.
 * All imports are done dynamically so EVM-only users pay zero overhead.
 *
 * Token addresses verified against:
 *   - Solana SPL Token Registry: https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json
 *   - USDC on Solana: https://developers.circle.com/stablecoins/usdc-contract-addresses
 *   - Raydium: https://docs.raydium.io/raydium/token-pairs-and-liquidity
 */

import type { TransactionInstruction } from "@solana/web3.js";

type SolanaWeb3Module = typeof import("@solana/web3.js");
type SplTokenModule = typeof import("@solana/spl-token");
type SolanaConnectionInstance = InstanceType<SolanaWeb3Module["Connection"]>;
type SolanaKeypairInstance = InstanceType<SolanaWeb3Module["Keypair"]>;
type SolanaPublicKeyInstance = InstanceType<SolanaWeb3Module["PublicKey"]>;

interface ParsedSplTokenWalletAccountEntry {
  account: {
    data: {
      parsed: {
        info: {
          mint: string;
          tokenAmount: { amount: string; decimals: number };
        };
      };
    };
  };
}

// ─── Well-known Solana token mint addresses ───────────────────────────────────
//
// All addresses are base-58 encoded Solana public keys.
// Sources: Solana token registry + Circle USDC docs

export const SOLANA_TOKENS = {
  // Native SOL (special: no mint address, use null or SystemProgram)
  SOL: null as null, // native, not a mint

  // USDC on Solana mainnet — Circle official
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",

  // USDT on Solana — Tether official
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",

  // Raydium
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",

  // Serum (now Openbook predecessor token)
  SRM: "SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt",

  // Bonk memecoin
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",

  // JitoSOL — Jito staked SOL
  JITOSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",

  // mSOL — Marinade staked SOL
  MSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",

  // Wrapped BTC on Solana (Portal/Wormhole)
  WBTC: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",

  // Wrapped ETH on Solana (Portal/Wormhole)
  WETH: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
} as const;

export type SolanaTokenSymbol = keyof typeof SOLANA_TOKENS;

export interface SolanaTokenInfo {
  symbol: SolanaTokenSymbol;
  mint: string | null; // null for native SOL
  decimals: number;
  name: string;
}

/** Known decimals for Solana tokens */
export const SOLANA_TOKEN_DECIMALS: Record<SolanaTokenSymbol, number> = {
  SOL: 9,
  USDC: 6,
  USDT: 6,
  RAY: 6,
  SRM: 6,
  BONK: 5,
  JITOSOL: 9,
  MSOL: 9,
  WBTC: 8,
  WETH: 8,
};

// ─── Dynamic import helper ────────────────────────────────────────────────────

// ─── Base58 decode (built-in, no extra dependency) ───────────────────────────

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(str: string): Uint8Array {
  const bytes: number[] = [0];
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`base58Decode: invalid character "${char}"`);
    let carry = idx;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Add leading zeros for leading '1' chars
  for (const char of str) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

async function loadSolanaWeb3(): Promise<SolanaWeb3Module> {
  try {
    // @ts-expect-error — @solana/web3.js is an optional peer dependency
    const mod = await import("@solana/web3.js");
    return mod;
  } catch {
    throw new Error(
      "SolanaWallet requires @solana/web3.js. Install it: npm install @solana/web3.js",
    );
  }
}

async function loadSplToken(): Promise<SplTokenModule> {
  try {
    // @ts-expect-error — @solana/spl-token is an optional peer dependency
    const mod = await import("@solana/spl-token");
    return mod;
  } catch {
    throw new Error(
      "SolanaWallet SPL token operations require @solana/spl-token. Install it: npm install @solana/spl-token",
    );
  }
}

// ─── SolanaWallet class ───────────────────────────────────────────────────────

export interface SolanaWalletConfig {
  /** Solana RPC endpoint (default: mainnet) */
  rpcUrl?: string;
  /** Base-58 encoded private key for the signer */
  privateKeyBase58?: string;
  /** Keypair bytes (Uint8Array of 64 bytes) */
  keypairBytes?: Uint8Array;
}

export interface SolBalanceResult {
  rawBalance: bigint; // lamports
  sol: string; // human-readable SOL
}

export interface SplBalanceResult {
  mint: string;
  rawBalance: bigint;
  humanBalance: string;
  decimals: number;
}

export interface SolanaTxResult {
  signature: string;
}

/**
 * Solana wallet for native SOL and SPL token operations.
 * Uses @solana/web3.js (optional peer dependency, dynamically imported).
 */
export class SolanaWallet {
  private readonly rpcUrl: string;
  private readonly config: SolanaWalletConfig;

  // Lazily loaded modules and connection
  private _connection: SolanaConnectionInstance | null = null;
  private _keypair: SolanaKeypairInstance | null = null;

  constructor(config: SolanaWalletConfig = {}) {
    this.rpcUrl = config.rpcUrl ?? "https://api.mainnet-beta.solana.com";
    this.config = config;
  }

  private async getConnection() {
    if (this._connection) return this._connection;
    const { Connection } = await loadSolanaWeb3();
    this._connection = new Connection(this.rpcUrl, "confirmed");
    return this._connection;
  }

  private async getKeypair() {
    if (this._keypair) return this._keypair;
    const { Keypair } = await loadSolanaWeb3();

    if (this.config.keypairBytes) {
      this._keypair = Keypair.fromSecretKey(this.config.keypairBytes);
    } else if (this.config.privateKeyBase58) {
      // bs58 decode — use the solana web3 module's bundled bs58 or a custom decode
      const solWeb3 = await loadSolanaWeb3();
      let decoded: Uint8Array;
      if (solWeb3.bs58) {
        decoded = solWeb3.bs58.decode(this.config.privateKeyBase58);
      } else {
        // Fallback: manually decode base58 (no external dep needed)
        decoded = base58Decode(this.config.privateKeyBase58);
      }
      this._keypair = Keypair.fromSecretKey(decoded);
    } else {
      throw new Error(
        "SolanaWallet: no private key provided. Set keypairBytes or privateKeyBase58 in config.",
      );
    }

    return this._keypair;
  }

  /** Get signer's public key as base-58 string */
  async getPublicKey(): Promise<string> {
    const kp = await this.getKeypair();
    return kp.publicKey.toBase58();
  }

  /**
   * Get native SOL balance.
   * @param address - Optional base-58 public key to check (defaults to wallet's key)
   */
  async getSolBalance(address?: string): Promise<SolBalanceResult> {
    const { PublicKey } = await loadSolanaWeb3();
    const connection = await this.getConnection();

    let pubkey: SolanaPublicKeyInstance;
    if (address) {
      pubkey = new PublicKey(address);
    } else {
      const kp = await this.getKeypair();
      pubkey = kp.publicKey;
    }

    const lamports = await connection.getBalance(pubkey);
    const rawBalance = BigInt(lamports);
    const sol = (lamports / 1e9).toFixed(9).replace(/\.?0+$/, "");

    return { rawBalance, sol };
  }

  /**
   * Get SPL token balance for a given mint.
   * @param mintAddress - SPL token mint address (base-58)
   * @param owner - Optional owner address (defaults to wallet's key)
   */
  async getSplTokenBalance(
    mintAddress: string,
    owner?: string,
  ): Promise<SplBalanceResult> {
    const { PublicKey } = await loadSolanaWeb3();
    const splToken = await loadSplToken();
    const connection = await this.getConnection();

    let ownerPubkey: SolanaPublicKeyInstance;
    if (owner) {
      ownerPubkey = new PublicKey(owner);
    } else {
      const kp = await this.getKeypair();
      ownerPubkey = kp.publicKey;
    }

    const mintPubkey = new PublicKey(mintAddress);

    // Get associated token account
    const ata = await splToken.getAssociatedTokenAddress(
      mintPubkey,
      ownerPubkey,
    );

    let rawBalance = 0n;
    let decimals = 9;

    try {
      const accountInfo = await splToken.getAccount(connection, ata);
      rawBalance = accountInfo.amount;

      // Get mint info for decimals
      const mintInfo = await splToken.getMint(connection, mintPubkey);
      decimals = mintInfo.decimals;
    } catch {
      // Token account doesn't exist — balance is 0
    }

    const humanBalance =
      (Number(rawBalance) / 10 ** decimals)
        .toFixed(decimals)
        .replace(/\.?0+$/, "") || "0";

    return { mint: mintAddress, rawBalance, humanBalance, decimals };
  }

  /**
   * Send native SOL to a recipient.
   * @param to - Recipient base-58 public key
   * @param amount - Lamports (bigint) OR SOL amount as string (e.g. "1.5")
   */
  async sendSol(to: string, amount: string | bigint): Promise<SolanaTxResult> {
    const { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } =
      await loadSolanaWeb3();
    const connection = await this.getConnection();
    const keypair = await this.getKeypair();

    let lamports: bigint;
    if (typeof amount === "string") {
      // Parse SOL string (9 decimals)
      const parts = amount.split(".");
      const intPart = BigInt(parts[0] || "0");
      const fracStr = (parts[1] ?? "").padEnd(9, "0").slice(0, 9);
      lamports = intPart * 1_000_000_000n + BigInt(fracStr);
    } else {
      lamports = amount;
    }

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: new PublicKey(to),
        lamports: Number(lamports),
      }),
    );

    const signature = await sendAndConfirmTransaction(connection, transaction, [
      keypair,
    ]);
    return { signature };
  }

  /**
   * Send SPL tokens to a recipient.
   * Creates the recipient's associated token account if it doesn't exist.
   *
   * @param to - Recipient base-58 public key
   * @param amount - Raw token units (bigint) OR human-readable string
   * @param mintAddress - SPL token mint address (base-58)
   */
  async sendSplToken(
    to: string,
    amount: string | bigint,
    mintAddress: string,
  ): Promise<SolanaTxResult> {
    const { PublicKey } = await loadSolanaWeb3();
    const splToken = await loadSplToken();
    const connection = await this.getConnection();
    const keypair = await this.getKeypair();

    const mintPubkey = new PublicKey(mintAddress);
    const toPubkey = new PublicKey(to);

    // Get mint info for decimals
    const mintInfo = await splToken.getMint(connection, mintPubkey);
    const { decimals } = mintInfo;

    // Parse amount
    let rawAmount: bigint;
    if (typeof amount === "string") {
      const parts = amount.split(".");
      const intPart = BigInt(parts[0] || "0");
      const fracStr = (parts[1] ?? "").padEnd(decimals, "0").slice(0, decimals);
      rawAmount = intPart * 10n ** BigInt(decimals) + BigInt(fracStr);
    } else {
      rawAmount = amount;
    }

    // Get sender's associated token account
    const fromAta = await splToken.getAssociatedTokenAddress(
      mintPubkey,
      keypair.publicKey,
    );

    // Get or create recipient's associated token account
    const toAta = await splToken.getAssociatedTokenAddress(
      mintPubkey,
      toPubkey,
    );

    // Build instructions
    const instructions: TransactionInstruction[] = [];

    // Check if recipient ATA exists
    const toAtaInfo = await connection.getAccountInfo(toAta);
    if (!toAtaInfo) {
      instructions.push(
        splToken.createAssociatedTokenAccountInstruction(
          keypair.publicKey, // payer
          toAta,
          toPubkey,
          mintPubkey,
        ),
      );
    }

    // Transfer instruction
    instructions.push(
      splToken.createTransferInstruction(
        fromAta,
        toAta,
        keypair.publicKey,
        rawAmount,
      ),
    );

    const { Transaction, sendAndConfirmTransaction } = await loadSolanaWeb3();
    const transaction = new Transaction().add(...instructions);

    const signature = await sendAndConfirmTransaction(connection, transaction, [
      keypair,
    ]);
    return { signature };
  }

  /**
   * List all SPL token accounts for the wallet.
   */
  async listSplTokenAccounts(): Promise<
    Array<{ mint: string; amount: bigint; decimals: number }>
  > {
    const splToken = await loadSplToken();
    const connection = await this.getConnection();
    const keypair = await this.getKeypair();

    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      keypair.publicKey,
      { programId: splToken.TOKEN_PROGRAM_ID },
    );

    return tokenAccounts.value.map((acc: ParsedSplTokenWalletAccountEntry) => {
      const info = acc.account.data.parsed.info;
      return {
        mint: info.mint,
        amount: BigInt(info.tokenAmount.amount),
        decimals: info.tokenAmount.decimals,
      };
    });
  }
}

/**
 * Create a SolanaWallet instance.
 */
export function createSolanaWallet(config: SolanaWalletConfig): SolanaWallet {
  return new SolanaWallet(config);
}
