import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  logger,
} from '@elizaos/core';
import { Connection, Keypair, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import BigNumber from 'bignumber.js';
import bs58 from 'bs58';
import { BirdeyeClient } from './clients';
import type { WalletPortfolioItem } from './types';

/**
 * Interface representing the result of generating a keypair.
 * @typedef {Object} KeypairResult
 * @property {Keypair} [keypair] - The generated keypair.
 * @property {PublicKey} [publicKey] - The public key of the generated keypair.
 */
export interface KeypairResult {
  keypair?: Keypair;
  publicKey?: PublicKey;
}

/**
 * Gets either a keypair or public key based on TEE mode and runtime settings
 * @param runtime The agent runtime
 * @param requirePrivateKey Whether to return a full keypair (true) or just public key (false)
 * @returns KeypairResult containing either keypair or public key
 */
/**
 * Retrieves the wallet key from the runtime settings.
 * If requirePrivateKey is set to true, it attempts to retrieve and decode the private key.
 * If requirePrivateKey is set to false, it retrieves and returns the public key.
 * * @param { IAgentRuntime } runtime - The runtime object containing the settings.
 * @param { boolean } [requirePrivateKey=true] - Flag indicating whether to retrieve the private key (default is true).
 * @returns {Promise<KeypairResult>} A Promise that resolves to the keypair or public key.
 * @throws { Error } If the private key or public key is not found in the settings, or if the key format is invalid.
 */
export async function getWalletKey(
  runtime: IAgentRuntime,
  requirePrivateKey = true
): Promise<KeypairResult> {
  // TEE mode is OFF
  if (requirePrivateKey) {
    const privateKeyString =
      runtime.getSetting('SOLANA_PRIVATE_KEY') ?? runtime.getSetting('WALLET_PRIVATE_KEY');

    if (!privateKeyString) {
      throw new Error('Private key not found in settings');
    }

    try {
      // First try base58
      const secretKey = bs58.decode(privateKeyString);
      return { keypair: Keypair.fromSecretKey(secretKey) };
    } catch (e) {
      logger.log('Error decoding base58 private key:', e);
      try {
        // Then try base64
        logger.log('Try decoding base64 instead');
        const secretKey = Uint8Array.from(Buffer.from(privateKeyString, 'base64'));
        return { keypair: Keypair.fromSecretKey(secretKey) };
      } catch (e2) {
        logger.error('Error decoding private key: ', e2);
        throw new Error('Invalid private key format');
      }
    }
  } else {
    const publicKeyString =
      runtime.getSetting('SOLANA_PUBLIC_KEY') ?? runtime.getSetting('WALLET_PUBLIC_KEY');

    if (!publicKeyString) {
      throw new Error('Public key not found in settings');
    }

    return { publicKey: new PublicKey(publicKeyString) };
  }
}

export interface Item {
  name: string;
  address: string;
  symbol: string;
  decimals: number;
  balance: string;
  uiAmount: string;
  priceUsd: string;
  valueUsd: string;
  valueSol?: string;
}

interface WalletPortfolio {
  totalUsd: string;
  totalSol?: string;
  items: Array<Item>;
}

interface _BirdEyePriceData {
  data: {
    [key: string]: {
      price: number;
      priceChange24h: number;
    };
  };
}

interface Prices {
  solana: { usd: string };
  bitcoin: { usd: string };
  ethereum: { usd: string };
}

export async function sendTransaction(connection: Connection, transaction: VersionedTransaction) {
  console.log('Sending transaction...');

  const latestBlockhash = await connection.getLatestBlockhash();

  const txid = await connection.sendTransaction(transaction, {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: 'confirmed',
  });

  console.log('Transaction sent:', txid);

  // Confirm transaction using the blockhash
  const confirmation = await connection.confirmTransaction(
    {
      signature: txid,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    },
    'confirmed'
  );

  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${confirmation.value.err}`);
  }

  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${confirmation.value.err}`);
  }

  return txid;
}

export class WalletProvider {
  static createFromRuntime(runtime: IAgentRuntime): WalletProvider {
    const address = runtime.getSetting('SOLANA_PUBLIC_KEY');

    if (!address) {
      throw new Error('SOLANA_PUBLIC_KEY not configured');
    }

    return new WalletProvider(runtime, new PublicKey(address));
  }

  constructor(
    private runtime: IAgentRuntime,
    public readonly publicKey: PublicKey
  ) {}

  async getAccountBalance(): Promise<bigint> {
    try {
      // Create a connection to the Solana network
      const connection = new Connection(
        this.runtime.getSetting('SOLANA_RPC_URL') || 'https://api.mainnet-beta.solana.com',
        'confirmed'
      );

      // Fetch the balance for the wallet's public key
      const balance = await connection.getBalance(this.publicKey);

      // Return the balance in lamports as a bigint
      return BigInt(balance);
    } catch (error) {
      console.error('Error fetching account balance:', error);
      throw new Error('Failed to fetch account balance');
    }
  }

  async fetchPortfolioValue(): Promise<WalletPortfolio> {
    return await BirdeyeClient.createFromRuntime(this.runtime).fetchPortfolioValue(
      this.publicKey.toBase58(),
      {
        chain: 'solana',
        expires: '5m', // TODO: configure this
      }
    );
  }

  async getTokensInWallet(): Promise<WalletPortfolioItem[]> {
    const walletInfo = await this.fetchPortfolioValue();
    return walletInfo.items;
  }

  // check if the token symbol is in the wallet
  async getTokenFromWallet(tokenSymbol: string) {
    try {
      const items = await this.getTokensInWallet();
      const token = items.find((item) => item.symbol === tokenSymbol);

      if (token) {
        return token.address;
      }
      return null;
    } catch (error) {
      console.error('Error checking token in wallet:', error);
      return null;
    }
  }

  formatPortfolio(portfolio: WalletPortfolio, prices: Prices): string {
    let output = '';
    output += `Wallet Address: ${this.publicKey.toBase58()}\n\n`;

    const totalUsdFormatted = new BigNumber(portfolio.totalUsd).toFixed(2);
    const totalSolFormatted = portfolio.totalSol;

    output += `Total Value: $${totalUsdFormatted} (${totalSolFormatted} SOL)\n\n`;
    output += 'Token Balances:\n';

    const nonZeroItems = portfolio.items.filter((item) =>
      new BigNumber(item.uiAmount).isGreaterThan(0)
    );

    if (nonZeroItems.length === 0) {
      output += 'No tokens found with non-zero balance\n';
    } else {
      for (const item of nonZeroItems) {
        const valueUsd = new BigNumber(item.valueUsd).toFixed(2);
        output += `${item.name} (${item.symbol}): ${new BigNumber(item.uiAmount).toFixed(
          6
        )} ($${valueUsd} | ${item.valueSol} SOL)\n`;
      }
    }

    output += '\nMarket Prices:\n';
    output += `SOL: $${new BigNumber(prices.solana.usd).toFixed(2)}\n`;
    output += `BTC: $${new BigNumber(prices.bitcoin.usd).toFixed(2)}\n`;
    output += `ETH: $${new BigNumber(prices.ethereum.usd).toFixed(2)}\n`;

    return output;
  }
}

export const walletProvider: Provider = {
  name: 'degen-solana-wallet',
  get: async (runtime: IAgentRuntime, _message: Memory): Promise<ProviderResult> => {
    try {
      const provider = WalletProvider.createFromRuntime(runtime);
      const [portfolio, prices] = await Promise.all([
        provider.fetchPortfolioValue(),
        BirdeyeClient.createFromRuntime(runtime).fetchPrices(),
      ]);

      const text = provider.formatPortfolio(portfolio, prices);
      return {
        data: {
          solanaPortfolio: portfolio,
        },
        values: {
          solanaPortfolio: text,
        },
        text,
      };
    } catch (error) {
      console.error('Error in wallet provider:', error);
      return null;
    }
  },
};
