import type { IAgentRuntime } from '@elizaos/core';
import {
  Connection,
  Keypair,
  type ParsedTransactionWithMeta,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { JupiterClient } from '../clients';
import { SOL_ADDRESS } from '../constants';
import type {
  QuoteInParams,
  QuoteResult,
  SwapInParams,
  SwapInResult,
  TrustWalletProvider,
} from '../types';
import { WalletProvider } from '../wallet';
import { JitoRegion, sendTxUsingJito } from './jitoBundle';
import { logger } from '@elizaos/core';

/**
 * Represents the result of a quote generated for a trade on the Jupiter protocol.
 * @typedef {Object} JupiterQuoteResult
 * @property {string} inputMint - The input mint for the trade.
 * @property {string} outputMint - The output mint for the trade.
 * @property {string} inAmount - The input amount for the trade.
 * @property {string} outAmount - The output amount for the trade.
 * @property {any[]} routePlan - The route plan for executing the trade.
 */
type JupiterQuoteResult = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  routePlan: any[];
};

/**
 * Loads a private key from the runtime settings and creates a keypair.
 *
 * @param {IAgentRuntime} runtime - The agent runtime interface.
 * @returns {Keypair} - The generated keypair.
 * @throws {Error} - If the private key format is invalid or the key length is incorrect.
 */
export function loadPrivateKey(runtime: IAgentRuntime) {
  const privateKeyString =
    runtime.getSetting('SOLANA_PRIVATE_KEY') ?? runtime.getSetting('WALLET_PRIVATE_KEY')!;

  let secretKey: Uint8Array;
  try {
    // First try to decode as base58
    secretKey = bs58.decode(privateKeyString);
    // eslint-disable-next-line
  } catch (_e) {
    try {
      // If that fails, try base64
      secretKey = Uint8Array.from(Buffer.from(privateKeyString, 'base64'));
      // eslint-disable-next-line
    } catch (_e2) {
      throw new Error('Invalid private key format');
    }
  }

  // Verify the key length
  if (secretKey.length !== 64) {
    console.error('Invalid key length:', secretKey.length);
    throw new Error(`Invalid private key length: ${secretKey.length}. Expected 64 bytes.`);
  }

  const keypair = Keypair.fromSecretKey(secretKey);

  // Verify the public key matches what we expect
  const expectedPublicKey =
    runtime.getSetting('SOLANA_PUBLIC_KEY') ?? runtime.getSetting('WALLET_PUBLIC_KEY');
  if (keypair.publicKey.toBase58() !== expectedPublicKey) {
    throw new Error("Generated public key doesn't match expected public key");
  }

  return keypair;
}

// todo: add later to evm wallet
// const hashLength: number = 32; // 32 bytes = 64 hex characters
// const prefix: string = "0x";
// const generateTransactionHash = (): string => {
//     const randomBytes = new Uint8Array(hashLength);
//     crypto.getRandomValues(randomBytes);

// todo: toHex
//     const hash = Array.from(randomBytes)
//         .map((b) => b.toString(16).padStart(2, "0"))
//         .join("");

//     return prefix + hash;
// };

const generateTransactionHash = (): string => {
  const hashBytes = new Uint8Array(32);
  crypto.getRandomValues(hashBytes);
  return bs58.encode(hashBytes);
};

/**
 * Represents a Trust Wallet provider for Solana blockchain with Jupiter integration.
 * @template JupiterQuoteResult - The type of Jupiter quote result.
 */
export class SolanaTrustWalletProvider implements TrustWalletProvider<JupiterQuoteResult> {
  /**
   * Creates a new instance of SolanaTrustWalletProvider using the provided runtime and wallet
   *
   * @param {IAgentRuntime} runtime - The agent runtime to use
   * @returns {SolanaTrustWalletProvider} - A new instance of SolanaTrustWalletProvider
   */
  static createFromRuntime(runtime: IAgentRuntime) {
    const wallet = WalletProvider.createFromRuntime(runtime);
    const connection = new Connection(runtime.getSetting('RPC_URL')!);
    return new SolanaTrustWalletProvider(runtime, wallet, connection);
  }

  /**
   * Constructor for creating an instance of an object.
   *
   * @param runtime - The agent runtime used for communication with the runtime environment.
   * @param wallet - The wallet provider used for managing cryptographic keys and identities.
   * @param connection - The connection object used for establishing and maintaining connections.
   */
  constructor(
    private runtime: IAgentRuntime,
    private wallet: WalletProvider,
    private connection: Connection
  ) {}

  /**
   * Get the address associated with the wallet.
   * @returns {string} The base58 encoded public key of the wallet.
   */
  getAddress(): string {
    return this.wallet.publicKey.toBase58();
  }

  /**
   * Returns the address of the currency.
   *
   * @returns {string} The currency address.
   */
  getCurrencyAddress(): string {
    return SOL_ADDRESS;
  }

  /**
   * Asynchronously retrieves the token with the specified symbol from the wallet.
   *
   * @param {string} tokenSymbol - The symbol of the token to retrieve.
   * @returns {Promise<string | null>} A promise that resolves with the token string if found, or null if not found.
   */
  async getTokenFromWallet(tokenSymbol: string): Promise<string | null> {
    return this.wallet.getTokenFromWallet(tokenSymbol);
  }

  /**
   * Asynchronously retrieves the account balance from the wallet.
   *
   * @returns {Promise<bigint>} A Promise that resolves with the account balance as a bigint.
   */
  async getAccountBalance(): Promise<bigint> {
    return this.wallet.getAccountBalance();
  }

  /**
   * Get a quote for performing a trade from one token to another.
   * @param {QuoteInParams} params - The parameters for getting the quote.
   * @param {string} params.inputToken - The input token for the trade.
   * @param {string} params.outputToken - The output token for the trade.
   * @param {number} params.amountIn - The amount of input token to trade.
   * @param {number} params.slippageBps - The slippage tolerance in basis points.
   * @returns {Promise<QuoteResult<JupiterQuoteResult>>} A promise that resolves to the quote result.
   */
  async getQuoteIn({
    inputToken,
    outputToken,
    amountIn,
    slippageBps,
  }: QuoteInParams): Promise<QuoteResult<JupiterQuoteResult>> {
    const quote = await JupiterClient.getQuote(
      inputToken,
      outputToken,
      amountIn.toString(),
      slippageBps
    );

    return {
      amountOut: BigInt(quote.outAmount),
      data: quote,
    };
  }

  /**
   * Performs a swap in operation based on the provided input parameters.
   *
   * @param {SwapInParams<JupiterQuoteResult>} options - The swap in parameters including inputToken, outputToken, minAmountOut, isSimulation, and data.
   * @returns {Promise<SwapInResult<ParsedTransactionWithMeta | null>>} A promise that resolves to a SwapInResult containing the transaction hash, timestamp, amount out, and details of the swap operation.
   */
  async swapIn({
    inputToken,
    outputToken,
    minAmountOut,
    isSimulation,
    data,
  }: SwapInParams<JupiterQuoteResult>): Promise<SwapInResult<ParsedTransactionWithMeta | null>> {
    if (isSimulation) {
      return {
        amountOut: data?.outAmount ? BigInt(data?.outAmount) : minAmountOut,
        timestamp: new Date(),
        txHash: generateTransactionHash(),
      };
    }

    const swapData = await JupiterClient.swap(data, this.getAddress());

    const { txHash, timestamp, amountOut, details } = await this.executeSwap({
      inputToken,
      outputToken,
      swapData,
    });

    return {
      txHash,
      timestamp,
      amountOut,
      data: details,
    };
  }

  /**
   * Executes a swap transaction by deserializing the swap data, signing the transaction,
   * getting the latest blockhash, sending the transaction using Jito, and retrieving transaction details.
   * @param {object} param0 - The parameters for executing the swap transaction.
   * @param {string} param0.inputToken - The input token for the swap.
   * @param {string} param0.outputToken - The output token for the swap.
   * @param {any} param0.swapData - The swap data containing the transaction details.
   * @returns {object} - An object containing the transaction hash, amount out, timestamp, and transaction details.
   */
  async executeSwap({
    outputToken,
    swapData,
  }: {
    inputToken: string;
    outputToken: string;
    swapData: any;
  }) {
    const transactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(transactionBuf);

    const keypair = loadPrivateKey(this.runtime);
    transaction.sign([keypair]);

    const latestBlockhash = await this.connection.getLatestBlockhash();

    const bundleResponse = await sendTxUsingJito({
      versionedTxs: [transaction],
      region: JitoRegion.Mainnet,
      authority: keypair,
      lastestBlockhash: latestBlockhash,
    });
    if (!bundleResponse) {
      throw new Error('Bundle response is null');
    }
    const txHash = bundleResponse?.transactions?.[0];

    if (!txHash) {
      throw new Error('Transaction hash is null');
    }
    // const txHash = await sendTransaction(this.connection, transaction);

    const details = await this.connection.getParsedTransaction(txHash, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    const owner = this.wallet.publicKey.toBase58();

    const preBalance =
      details?.meta?.preTokenBalances?.find(
        (tokenBalance) => tokenBalance.owner === owner && tokenBalance.mint === outputToken
      )?.uiTokenAmount.amount ?? '0';

    const postBalance =
      details?.meta?.postTokenBalances?.find(
        (tokenBalance) => tokenBalance.owner === owner && tokenBalance.mint === outputToken
      )?.uiTokenAmount.amount ?? '0';

    const amountOut = BigInt(postBalance) - BigInt(preBalance);

    return {
      txHash,
      amountOut,
      timestamp: details?.blockTime ? new Date(details.blockTime) : new Date(),
      details,
    };
  }
}
