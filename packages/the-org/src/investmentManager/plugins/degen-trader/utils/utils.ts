import { type IAgentRuntime, logger } from '@elizaos/core';
import { PublicKey } from '@solana/web3.js';

/**
 * Validates a Solana address format
 */
/**
 * Checks if a given string is a valid Solana address.
 * * @param { string } address - The Solana address to validate.
 * @returns { boolean } - Returns true if the address is valid, false otherwise.
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
): Promise<any> {
  let lastError: Error;

  for (let i = 0; i < maxRetries; i++) {
    try {
      logger.log(`API request attempt ${i + 1} for ${chain}:`, {
        url,
        attempt: i + 1,
      });

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

      return JSON.parse(responseText);
    } catch (error) {
      logger.error(`Request attempt ${i + 1} failed:`, {
        error: error instanceof Error ? error.message : String(error),
        url,
        chain,
        attempt: i + 1,
      });

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
