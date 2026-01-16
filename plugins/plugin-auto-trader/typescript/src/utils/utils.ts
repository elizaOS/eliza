import { logger, type IAgentRuntime } from '@elizaos/core';
// JsonValue is not directly exported from @elizaos/core, define locally
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
import { PublicKey } from '@solana/web3.js';

/**
 * Validates a Solana address format
 */
export function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetches data with retry logic and proper error handling
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  chain: 'solana' | 'base' = 'solana',
  maxRetries = 3
): Promise<JsonValue> {
  let lastError: Error = new Error('No attempts made');

  for (let i = 0; i < maxRetries; i++) {
    try {
      logger.log(
        { url, attempt: i + 1 },
        `API request attempt ${i + 1} for ${chain}`,
      );

      const headers = {
        Accept: 'application/json',
        'x-chain': chain,
        ...options.headers,
      };

      const response = await fetch(url, {
        ...options,
        headers,
      });

      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}, message: ${responseText}`);
      }

      return JSON.parse(responseText) as JsonValue;
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          url,
          chain,
          attempt: i + 1,
        },
        `Request attempt ${i + 1} failed`,
      );

      lastError = error instanceof Error ? error : new Error(String(error));

      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** i));
      }
    }
  }

  throw lastError;
}

/**
 * Decodes a base58 string to Uint8Array
 */
export function decodeBase58(str: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const ALPHABET_MAP = new Map(ALPHABET.split('').map((c, i) => [c, BigInt(i)]));

  let result = BigInt(0);
  for (const char of str) {
    const value = ALPHABET_MAP.get(char);
    if (value === undefined) {
      throw new Error('Invalid base58 character');
    }
    result = result * BigInt(58) + value;
  }

  const bytes = [];
  while (result > 0n) {
    bytes.unshift(Number(result & 0xffn));
    result = result >> 8n;
  }

  // Add leading zeros
  for (let i = 0; i < str.length && str[i] === '1'; i++) {
    bytes.unshift(0);
  }

  return new Uint8Array(bytes);
}

/**
 * Tracks analyzed tokens with timestamps
 */
export interface AnalyzedToken {
  address: string;
  timestamp: number;
  symbol: string;
}

/**
 * Manages analyzed token history
 */
export async function manageAnalyzedTokens(
  runtime: IAgentRuntime,
  state: any,
  newToken?: AnalyzedToken
): Promise<AnalyzedToken[]> {
  try {
    const historyKey = 'analyzed_tokens_history';
    let history: AnalyzedToken[] = [];

    if (state?.[historyKey]) {
      try {
        const parsed = JSON.parse(state[historyKey]);
        if (Array.isArray(parsed)) {
          history = parsed;
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.warn({ error: message }, 'Failed to parse token history');
      }
    }

    const now = Date.now();
    history = history.filter(
      (token) => token?.timestamp && now - token.timestamp < 24 * 60 * 60 * 1000 // 24 hours
    );

    if (newToken) {
      history.push(newToken);
      logger.log(
        {
          address: newToken.address,
          symbol: newToken.symbol,
          historySize: history.length,
        },
        'Added new token to analysis history',
      );
    }

    // Note: State updates should be handled by the caller
    // since IAgentRuntime doesn't have updateRecentMessageState

    return history;
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        errorStack: error instanceof Error ? error.stack : undefined,
      },
      'Failed to manage token history',
    );
    return [];
  }
}
