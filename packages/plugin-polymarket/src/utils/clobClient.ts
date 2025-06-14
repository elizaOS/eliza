import { type IAgentRuntime, logger } from '@elizaos/core';
import { ClobClient } from '@polymarket/clob-client';
import { Chain } from '@polymarket/clob-client';
import { ethers } from 'ethers';

// Re-export the ClobClient type for other modules
export type { ClobClient } from '@polymarket/clob-client';

// Define the ApiKeyCreds interface to match the official client
export interface ApiKeyCreds {
  key: string;
  secret: string;
  passphrase: string;
}

/**
 * Create a wallet adapter that bridges ethers v5/v6 compatibility
 * The ClobClient and order-utils expect specific method signatures
 */
function createEthersV5CompatibleWallet(wallet: ethers.Wallet) {
  const adapter = {
    // Core properties
    address: wallet.address,
    provider: wallet.provider,
    _isSigner: true,

    // V6 methods (current ethers)
    getAddress: async () => wallet.address,
    signMessage: async (message: string | Uint8Array) => wallet.signMessage(message),
    signTypedData: async (domain: any, types: any, value: any) =>
      wallet.signTypedData(domain, types, value),
    signTransaction: async (transaction: any) => wallet.signTransaction(transaction),
    connect: (provider: any) => wallet.connect(provider),

    // V5 compatibility methods (what order-utils expects)
    _signTypedData: async (domain: any, types: any, value: any) => {
      // Bridge to v6 method
      return wallet.signTypedData(domain, types, value);
    },

    // Additional properties that might be expected
    _index: (wallet as any)._index,
    _mnemonic: (wallet as any)._mnemonic,
    publicKey: (wallet as any).publicKey,
    privateKey: wallet.privateKey,
  };

  // Create a proxy to handle any missing method calls
  return new Proxy(adapter, {
    get(target: any, prop: string | symbol) {
      if (prop in target) {
        return target[prop];
      }
      // If the property exists on the original wallet, return it
      if (prop in wallet && typeof (wallet as any)[prop] === 'function') {
        return (...args: any[]) => (wallet as any)[prop](...args);
      }
      if (prop in wallet) {
        return (wallet as any)[prop];
      }
      return undefined;
    },
  });
}

/**
 * Initialize CLOB client with wallet-based authentication
 * @param runtime - The agent runtime containing configuration
 * @returns Configured CLOB client instance
 */
export async function initializeClobClient(runtime: IAgentRuntime): Promise<ClobClient> {
  const clobApiUrl = runtime.getSetting('CLOB_API_URL') || 'https://clob.polymarket.com';
  const clobWsUrl =
    runtime.getSetting('CLOB_WS_URL') || 'wss://ws-subscriptions-clob.polymarket.com/ws/';

  const privateKey =
    runtime.getSetting('WALLET_PRIVATE_KEY') ||
    runtime.getSetting('PRIVATE_KEY') ||
    runtime.getSetting('POLYMARKET_PRIVATE_KEY');

  if (!privateKey) {
    throw new Error(
      'No private key found. Please set WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY in your environment'
    );
  }

  logger.info(
    `[initializeClobClient] Initializing CLOB client with HTTP URL: ${clobApiUrl}` +
      (clobWsUrl ? ` and WS URL: ${clobWsUrl}` : ' (no WS URL provided)')
  );

  try {
    // Create ethers v5 compatible wallet adapter
    const wallet = new ethers.Wallet(privateKey);
    const walletAdapter = createEthersV5CompatibleWallet(wallet);

    logger.info(`[initializeClobClient] Wallet address: ${wallet.address}`);
    logger.info(`[initializeClobClient] Chain ID: 137`);

    // Pass the compatible wallet adapter to ClobClient
    const client = new ClobClient(
      clobApiUrl,
      Chain.POLYGON, // Chain ID (137) as second parameter
      walletAdapter as any // V5 compatible adapter
    );

    logger.info(
      `[initializeClobClient] CLOB client initialized successfully with v5 compatible wallet` +
        (clobWsUrl ? ' and WebSocket support.' : '.')
    );
    return client;
  } catch (error) {
    logger.error(`[initializeClobClient] Failed to initialize CLOB client:`, error);
    throw new Error(
      `Failed to initialize CLOB client: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Initialize CLOB client with API credentials for L2 authenticated operations
 * @param runtime - The agent runtime containing configuration
 * @returns Configured CLOB client instance with API credentials
 */
export async function initializeClobClientWithCreds(runtime: IAgentRuntime): Promise<ClobClient> {
  const clobApiUrl = runtime.getSetting('CLOB_API_URL') || 'https://clob.polymarket.com';
  const clobWsUrl =
    runtime.getSetting('CLOB_WS_URL') || 'wss://ws-subscriptions-clob.polymarket.com/ws/';

  const privateKey =
    runtime.getSetting('WALLET_PRIVATE_KEY') ||
    runtime.getSetting('PRIVATE_KEY') ||
    runtime.getSetting('POLYMARKET_PRIVATE_KEY');

  if (!privateKey) {
    throw new Error(
      'No private key found. Please set WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY in your environment'
    );
  }

  const apiKey = runtime.getSetting('CLOB_API_KEY');
  const apiSecret = runtime.getSetting('CLOB_API_SECRET') || runtime.getSetting('CLOB_SECRET');
  const apiPassphrase =
    runtime.getSetting('CLOB_API_PASSPHRASE') || runtime.getSetting('CLOB_PASS_PHRASE');

  logger.info(`[initializeClobClientWithCreds] Checking credentials and URLs:`, {
    hasApiKey: !!apiKey,
    hasApiSecret: !!apiSecret,
    hasApiPassphrase: !!apiPassphrase,
    httpUrl: clobApiUrl,
    wsUrl: clobWsUrl || 'not provided',
    apiKeyPreview: apiKey ? `${apiKey.substring(0, 8)}...` : 'missing',
  });

  if (!apiKey || !apiSecret || !apiPassphrase) {
    const missing = [];
    if (!apiKey) missing.push('CLOB_API_KEY');
    if (!apiSecret) missing.push('CLOB_API_SECRET or CLOB_SECRET');
    if (!apiPassphrase) missing.push('CLOB_API_PASSPHRASE or CLOB_PASS_PHRASE');
    throw new Error(
      `Missing required API credentials: ${missing.join(', ')}. Please set these environment variables first.`
    );
  }

  logger.info(`[initializeClobClientWithCreds] Initializing CLOB client with API credentials.`);

  try {
    // Create ethers v5 compatible wallet adapter
    const wallet = new ethers.Wallet(privateKey);
    const walletAdapter = createEthersV5CompatibleWallet(wallet);

    const creds: ApiKeyCreds = {
      key: apiKey,
      secret: apiSecret,
      passphrase: apiPassphrase,
    };

    logger.info(`[initializeClobClientWithCreds] Wallet address: ${wallet.address}`);
    logger.info(`[initializeClobClientWithCreds] Chain ID: 137`);

    // Pass the compatible wallet adapter to ClobClient
    const client = new ClobClient(
      clobApiUrl,
      Chain.POLYGON, // Chain ID (137) as second parameter
      walletAdapter as any, // V5 compatible adapter
      creds
    );

    logger.info(
      `[initializeClobClientWithCreds] CLOB client initialized successfully with API credentials and v5 compatible wallet` +
        (clobWsUrl ? ' and WebSocket support.' : '.')
    );
    return client;
  } catch (error) {
    logger.error(`[initializeClobClientWithCreds] Failed to initialize CLOB client:`, error);
    throw new Error(
      `Failed to initialize CLOB client with credentials: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
