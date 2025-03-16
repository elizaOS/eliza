import {
  type Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

// Constants
const JITO_TIP_LAMPORTS = 40_000;
const MAX_BUNDLE_STATUS_ATTEMPTS = 10;
const BUNDLE_STATUS_CHECK_DELAY = 5000; // 5 seconds
const JSON_RPC_VERSION = '2.0';
const DEFAULT_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Enum representing different regions for Jito service.
 *
 * @enum {string}
 * @readonly
 * @property {string} Mainnet - Mainnet region
 * @property {string} Amsterdam - Amsterdam region
 * @property {string} Frankfurt - Frankfurt region
 * @property {string} NY - New York region
 * @property {string} Tokyo - Tokyo region
 */
export enum JitoRegion {
  Mainnet = 'mainnet',
  Amsterdam = 'amsterdam',
  Frankfurt = 'frankfurt',
  NY = 'ny',
  Tokyo = 'tokyo',
}

export const JitoEndpoints: Record<JitoRegion, string> = {
  [JitoRegion.Mainnet]: 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  [JitoRegion.Amsterdam]: 'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  [JitoRegion.Frankfurt]: 'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
  [JitoRegion.NY]: 'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
  [JitoRegion.Tokyo]: 'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
};

/**
 * Interface representing a response object containing information about a bundle.
 * @typedef {object} BundleResponse
 * @property {string} signature - The signature of the bundle.
 * @property {string} bundleStatus - The status of the bundle.
 * @property {string[]} transactions - An array of strings representing transactions in the bundle.
 */
interface BundleResponse {
  signature: string;
  bundleStatus: string;
  transactions: string[];
}

/**
 * Interface representing the response from a Jito API request.
 * @template T - Type of the `result` property.
 */
interface JitoApiResponse {
  result: any;
  error?: { message: string };
}

// Helper Functions
/**
 * Returns the Jito endpoint URL based on the specified region.
 *
 * @param {JitoRegion} region - The region for which the Jito endpoint URL is needed.
 * @returns {string} The Jito endpoint URL corresponding to the specified region.
 */
export function getJitoEndpoint(region: JitoRegion): string {
  return JitoEndpoints[region];
}

/**
 * Fetches a random validator PublicKey from a Jito API endpoint.
 *
 * @param {string} rpcEndpoint The RPC endpoint URL to fetch the validator data from.
 * @returns {Promise<PublicKey>} A Promise that resolves to a random PublicKey of a validator.
 */
export async function getRandomValidator(rpcEndpoint: string): Promise<PublicKey> {
  const payload = {
    jsonrpc: JSON_RPC_VERSION,
    id: 1,
    method: 'getTipAccounts',
    params: [],
  };

  try {
    const res = await fetch(rpcEndpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: DEFAULT_HEADERS,
    });
    const json: JitoApiResponse = await res.json();

    if (json.error) {
      throw new Error(`Jito API Error: ${json.error.message}`);
    }

    const validators = json.result as string[];
    const randomIndex = Math.floor(Math.random() * validators.length);
    return new PublicKey(validators[randomIndex]);
  } catch (error) {
    console.error('Error fetching random validator:', error);
    throw error;
  }
}

/**
 * Sends a POST request to the Jito API endpoint with the provided payload.
 *
 * @param {string} endpoint - The endpoint of the Jito API.
 * @param {any} payload - The data to be sent in the request body.
 * @returns {Promise<JitoApiResponse>} - A promise that resolves with the API response.
 * @throws {Error} - If an error occurs during the API request or if the API response indicates an error.
 */
async function fetchJitoApi(endpoint: string, payload: any): Promise<JitoApiResponse> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: DEFAULT_HEADERS,
    });
    const json: JitoApiResponse = await res.json();

    if (json.error) {
      throw new Error(`Jito API Error: ${json.error.message}`);
    }

    return json;
  } catch (error) {
    console.error('Error in Jito API request:', error);
    throw error;
  }
}

// Main Function
/**
 * Sends a transaction bundle using Jito API.
 * @param {Object} options - The options for sending the transaction bundle.
 * @param {VersionedTransaction[]} options.versionedTxs - The versioned transactions to be included in the bundle.
 * @param {JitoRegion} [options.region=JitoRegion.Mainnet] - The Jito region to use for sending the transaction bundle.
 * @param {Keypair} options.authority - The authority keypair to sign the transactions.
 * @param {Object} options.lastestBlockhash - The latest blockhash object containing the blockhash string.
 * @returns {Promise<BundleResponse | null>} A promise that resolves with the bundle response object or null if the bundle fails.
 */
export async function sendTxUsingJito({
  versionedTxs,
  region = JitoRegion.Mainnet,
  authority,
  lastestBlockhash,
}: {
  versionedTxs: VersionedTransaction[];
  region: JitoRegion;
  authority: Keypair;
  lastestBlockhash: { blockhash: string };
}): Promise<BundleResponse | null> {
  const rpcEndpoint = getJitoEndpoint(region);
  const tipAccount = await getRandomValidator(rpcEndpoint);

  // Create Jito fee transaction
  const jitoFeeMessage = new TransactionMessage({
    payerKey: authority.publicKey,
    recentBlockhash: lastestBlockhash.blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: tipAccount,
        lamports: JITO_TIP_LAMPORTS,
      }),
    ],
  }).compileToV0Message();

  const jitoFeeTransaction = new VersionedTransaction(jitoFeeMessage);
  jitoFeeTransaction.sign([authority]);

  // Serialize transactions
  const serializedJitoFeeTransaction = bs58.encode(jitoFeeTransaction.serialize());
  const encodedVersionedTxs = versionedTxs.map((tx) => bs58.encode(tx.serialize()));
  const finalTransaction = [...encodedVersionedTxs, serializedJitoFeeTransaction];

  // Send bundle
  const payload = {
    jsonrpc: JSON_RPC_VERSION,
    id: 1,
    method: 'sendBundle',
    params: [finalTransaction],
  };

  try {
    const json = await fetchJitoApi(`${rpcEndpoint}?bundleOnly=true`, payload);
    const bundleTxn = json.result;

    // Check bundle status
    let bundleStatus;
    let attempts = 0;

    while (
      bundleStatus !== 'Landed' &&
      bundleStatus !== 'Failed' &&
      attempts < MAX_BUNDLE_STATUS_ATTEMPTS
    ) {
      const statusResponse = await fetchJitoApi(rpcEndpoint, {
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: 'getInflightBundleStatuses',
        params: [[bundleTxn]],
      });

      bundleStatus = statusResponse?.result?.value[0]?.status;
      attempts++;

      if (bundleStatus === 'Failed') {
        console.error('Bundle failed to land');
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, BUNDLE_STATUS_CHECK_DELAY));
    }

    let transactions;
    if (bundleStatus === 'Landed') {
      const bundleStatuses = await fetchJitoApi(rpcEndpoint, {
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: 'getBundleStatuses',
        params: [[bundleTxn]],
      });

      transactions = bundleStatuses?.result?.value[0]?.transactions;
    }

    return {
      signature: bundleTxn,
      bundleStatus: bundleStatus || 'Unknown',
      transactions: transactions || [],
    };
  } catch (error) {
    console.error('Error in sendTxUsingJito:', error);
    throw error;
  }
}
