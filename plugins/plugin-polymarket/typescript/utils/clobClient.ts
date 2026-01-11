/**
 * @elizaos/plugin-polymarket CLOB Client Utilities
 *
 * Utilities for initializing and managing Polymarket CLOB client connections.
 * Uses viem for wallet operations to integrate with plugin-evm.
 */

import { type IAgentRuntime, logger } from "@elizaos/core";
import { ClobClient } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { DEFAULT_CLOB_API_URL, POLYGON_CHAIN_ID } from "../constants";
import type { ApiKeyCreds } from "../types";

// Re-export types for other modules
export type { ClobClient } from "@polymarket/clob-client";
export type { BookParams } from "../types";

/**
 * Get private key from runtime settings
 */
function getPrivateKey(runtime: IAgentRuntime): `0x${string}` {
  const privateKey =
    runtime.getSetting("POLYMARKET_PRIVATE_KEY") ||
    runtime.getSetting("EVM_PRIVATE_KEY") ||
    runtime.getSetting("WALLET_PRIVATE_KEY") ||
    runtime.getSetting("PRIVATE_KEY");

  if (!privateKey) {
    throw new Error(
      "No private key found. Please set POLYMARKET_PRIVATE_KEY, EVM_PRIVATE_KEY, or WALLET_PRIVATE_KEY in your environment"
    );
  }

  // Ensure it has 0x prefix
  const keyStr = String(privateKey);
  const key = keyStr.startsWith("0x") ? keyStr : `0x${keyStr}`;
  return key as `0x${string}`;
}

interface EnhancedWallet {
  address: string;
  getAddress: () => Promise<string>;
  _signTypedData: (
    domain: Record<string, unknown>,
    types: Record<string, unknown>,
    value: Record<string, unknown>
  ) => Promise<string>;
}

/**
 * Type alias for the ClobClient's signer parameter.
 * The ClobClient expects a specific signer interface that our EnhancedWallet satisfies.
 */
type ClobClientSigner = ConstructorParameters<typeof ClobClient>[2];

/**
 * Cast EnhancedWallet to ClobClient's signer type.
 * Our EnhancedWallet implements the same interface the ClobClient expects.
 */
function asClobClientSigner(wallet: EnhancedWallet): ClobClientSigner {
  return wallet as ClobClientSigner;
}

/**
 * Create an enhanced wallet object compatible with CLOB client
 */
function createEnhancedWallet(privateKey: `0x${string}`): EnhancedWallet {
  const account = privateKeyToAccount(privateKey);

  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  return {
    address: account.address,
    getAddress: async () => account.address,
    _signTypedData: async (
      domain: Record<string, unknown>,
      types: Record<string, unknown>,
      value: Record<string, unknown>
    ) => {
      // Find the primary type (not EIP712Domain)
      const primaryType = Object.keys(types).find((k) => k !== "EIP712Domain") ?? "";

      return walletClient.signTypedData({
        account,
        domain: domain as Parameters<typeof walletClient.signTypedData>[0]["domain"],
        types: types as Parameters<typeof walletClient.signTypedData>[0]["types"],
        primaryType,
        message: value,
      });
    },
  };
}

/**
 * Initialize CLOB client with wallet-based authentication
 * @param runtime - The agent runtime containing configuration
 * @returns Configured CLOB client instance
 */
export async function initializeClobClient(runtime: IAgentRuntime): Promise<ClobClient> {
  const clobApiUrl = String(runtime.getSetting("CLOB_API_URL") || DEFAULT_CLOB_API_URL);

  const privateKey = getPrivateKey(runtime);
  const enhancedWallet = createEnhancedWallet(privateKey);

  logger.info(`[initializeClobClient] Initializing CLOB client with HTTP URL: ${clobApiUrl}`);
  logger.info(`[initializeClobClient] Wallet address: ${enhancedWallet.address}`);
  logger.info(`[initializeClobClient] Chain ID: ${POLYGON_CHAIN_ID}`);

  const client = new ClobClient(
    clobApiUrl,
    POLYGON_CHAIN_ID,
    asClobClientSigner(enhancedWallet),
    undefined // No API creds for basic client
  );

  logger.info("[initializeClobClient] CLOB client initialized successfully with EOA wallet");
  return client;
}

/**
 * Initialize CLOB client with API credentials for L2 authenticated operations
 * @param runtime - The agent runtime containing configuration
 * @returns Configured CLOB client instance with API credentials
 */
export async function initializeClobClientWithCreds(runtime: IAgentRuntime): Promise<ClobClient> {
  const clobApiUrl = String(runtime.getSetting("CLOB_API_URL") || DEFAULT_CLOB_API_URL);

  const privateKey = getPrivateKey(runtime);

  const apiKey = runtime.getSetting("CLOB_API_KEY");
  const apiSecret = runtime.getSetting("CLOB_API_SECRET") || runtime.getSetting("CLOB_SECRET");
  const apiPassphrase =
    runtime.getSetting("CLOB_API_PASSPHRASE") || runtime.getSetting("CLOB_PASS_PHRASE");

  logger.info(
    `[initializeClobClientWithCreds] Checking credentials: hasApiKey=${Boolean(apiKey)}, hasApiSecret=${Boolean(apiSecret)}, hasApiPassphrase=${Boolean(apiPassphrase)}`
  );

  if (!apiKey || !apiSecret || !apiPassphrase) {
    const missing: string[] = [];
    if (!apiKey) missing.push("CLOB_API_KEY");
    if (!apiSecret) missing.push("CLOB_API_SECRET or CLOB_SECRET");
    if (!apiPassphrase) missing.push("CLOB_API_PASSPHRASE or CLOB_PASS_PHRASE");
    throw new Error(
      `Missing required API credentials: ${missing.join(", ")}. Please set these environment variables first.`
    );
  }

  const enhancedWallet = createEnhancedWallet(privateKey);

  const creds: ApiKeyCreds = {
    key: String(apiKey),
    secret: String(apiSecret),
    passphrase: String(apiPassphrase),
  };

  logger.info(`[initializeClobClientWithCreds] Wallet address: ${enhancedWallet.address}`);
  logger.info(`[initializeClobClientWithCreds] Chain ID: ${POLYGON_CHAIN_ID}`);

  const client = new ClobClient(
    clobApiUrl,
    POLYGON_CHAIN_ID,
    asClobClientSigner(enhancedWallet),
    creds
  );

  logger.info(
    "[initializeClobClientWithCreds] CLOB client initialized successfully with API credentials"
  );
  return client;
}

/**
 * Get the wallet address from runtime settings
 */
export function getWalletAddress(runtime: IAgentRuntime): string {
  const privateKey = getPrivateKey(runtime);
  const account = privateKeyToAccount(privateKey);
  return account.address;
}
