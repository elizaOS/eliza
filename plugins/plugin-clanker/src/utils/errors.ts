import { ErrorCode, ErrorResponse } from '../types';
import { logger } from '@elizaos/core';

export { ErrorCode };

export class ClankerError extends Error {
  code: ErrorCode;
  details?: any;
  suggestions?: string[];

  constructor(code: ErrorCode, message: string, details?: any, suggestions?: string[]) {
    super(message);
    this.name = 'ClankerError';
    this.code = code;
    this.details = details;
    this.suggestions = suggestions;
  }

  toResponse(): ErrorResponse {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      suggestions: this.suggestions,
    };
  }
}

export function handleError(error: unknown): ErrorResponse {
  logger.error('Clanker plugin error:', error instanceof Error ? error.message : String(error));

  if (error instanceof ClankerError) {
    return error.toResponse();
  }

  if (error instanceof Error) {
    // Check for common errors
    if (error.message.includes('insufficient funds')) {
      return new ClankerError(
        ErrorCode.INSUFFICIENT_BALANCE,
        'Insufficient balance to complete transaction',
        { originalError: error.message },
        ['Check your wallet balance', 'Ensure you have enough ETH for gas fees']
      ).toResponse();
    }

    if (error.message.includes('network') || error.message.includes('connection')) {
      return new ClankerError(
        ErrorCode.NETWORK_ERROR,
        'Network connection error',
        { originalError: error.message },
        ['Check your internet connection', 'Verify RPC endpoint is accessible']
      ).toResponse();
    }

    if (error.message.includes('slippage')) {
      return new ClankerError(
        ErrorCode.SLIPPAGE_EXCEEDED,
        'Transaction would exceed slippage tolerance',
        { originalError: error.message },
        ['Try increasing slippage tolerance', 'Wait for lower volatility']
      ).toResponse();
    }

    if (error.message.includes('reverted')) {
      return new ClankerError(
        ErrorCode.TRANSACTION_FAILED,
        'Transaction reverted on chain',
        { originalError: error.message },
        ['Check transaction parameters', 'Ensure contract state allows this operation']
      ).toResponse();
    }
  }

  // Generic error
  return new ClankerError(
    ErrorCode.PROTOCOL_ERROR,
    'An unexpected error occurred',
    { originalError: String(error) },
    ['Please try again', 'Contact support if the issue persists']
  ).toResponse();
}

export function validateAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export function validateAmount(amount: string): boolean {
  try {
    const num = BigInt(amount);
    return num >= 0n;
  } catch {
    return false;
  }
}