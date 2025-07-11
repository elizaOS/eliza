import { PATTERNS } from '../core/constants';

/**
 * Validate NEAR account ID format
 */
export function isValidAccountId(
  accountId: string,
  network: 'mainnet' | 'testnet' = 'mainnet'
): boolean {
  if (!accountId || typeof accountId !== 'string') {
    return false;
  }

  const pattern = network === 'mainnet' ? PATTERNS.ACCOUNT_ID : PATTERNS.TESTNET_ACCOUNT_ID;
  return pattern.test(accountId);
}

/**
 * Validate amount format
 */
export function isValidAmount(amount: string | number): boolean {
  if (amount === null || amount === undefined) {
    return false;
  }

  const amountStr = amount.toString();
  return PATTERNS.AMOUNT.test(amountStr) && parseFloat(amountStr) > 0;
}

/**
 * Validate token ID format
 */
export function isValidTokenId(tokenId: string): boolean {
  if (!tokenId || typeof tokenId !== 'string') {
    return false;
  }

  return PATTERNS.TOKEN_ID.test(tokenId);
}

/**
 * Validate transaction hash format
 */
export function isValidTransactionHash(hash: string): boolean {
  if (!hash || typeof hash !== 'string') {
    return false;
  }

  return PATTERNS.TRANSACTION_HASH.test(hash);
}

/**
 * Validate slippage tolerance
 */
export function isValidSlippage(slippage: number): boolean {
  return typeof slippage === 'number' && slippage >= 0 && slippage <= 1;
}

/**
 * Format account ID for display
 */
export function formatAccountId(accountId: string, maxLength: number = 20): string {
  if (!accountId || accountId.length <= maxLength) {
    return accountId;
  }

  const start = accountId.substring(0, 6);
  const end = accountId.substring(accountId.length - 6);
  return `${start}...${end}`;
}

/**
 * Format transaction hash for display
 */
export function formatTransactionHash(hash: string): string {
  if (!hash || hash.length <= 12) {
    return hash;
  }

  return `${hash.substring(0, 6)}...${hash.substring(hash.length - 4)}`;
}
