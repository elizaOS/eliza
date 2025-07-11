import { elizaLogger } from '@elizaos/core';

export enum NearErrorCode {
  // Configuration errors
  INVALID_CONFIG = 'NEAR_INVALID_CONFIG',
  MISSING_CREDENTIALS = 'NEAR_MISSING_CREDENTIALS',

  // Network errors
  RPC_ERROR = 'NEAR_RPC_ERROR',
  NETWORK_UNAVAILABLE = 'NEAR_NETWORK_UNAVAILABLE',

  // Account errors
  ACCOUNT_NOT_FOUND = 'NEAR_ACCOUNT_NOT_FOUND',
  INSUFFICIENT_BALANCE = 'NEAR_INSUFFICIENT_BALANCE',
  INSUFFICIENT_GAS = 'NEAR_INSUFFICIENT_GAS',

  // Transaction errors
  TRANSACTION_FAILED = 'NEAR_TRANSACTION_FAILED',
  INVALID_TRANSACTION = 'NEAR_INVALID_TRANSACTION',
  SIMULATION_FAILED = 'NEAR_SIMULATION_FAILED',

  // Token errors
  TOKEN_NOT_FOUND = 'NEAR_TOKEN_NOT_FOUND',
  INVALID_TOKEN_ADDRESS = 'NEAR_INVALID_TOKEN_ADDRESS',
  NO_STORAGE_DEPOSIT = 'NEAR_NO_STORAGE_DEPOSIT',

  // Swap errors
  NO_SWAP_ROUTE = 'NEAR_NO_SWAP_ROUTE',
  INSUFFICIENT_LIQUIDITY = 'NEAR_INSUFFICIENT_LIQUIDITY',
  SLIPPAGE_EXCEEDED = 'NEAR_SLIPPAGE_EXCEEDED',

  // Staking errors
  VALIDATOR_NOT_FOUND = 'NEAR_VALIDATOR_NOT_FOUND',
  STAKE_TOO_SMALL = 'NEAR_STAKE_TOO_SMALL',
  UNSTAKE_NOT_READY = 'NEAR_UNSTAKE_NOT_READY',

  // General errors
  UNKNOWN_ERROR = 'NEAR_UNKNOWN_ERROR',
  OPERATION_CANCELLED = 'NEAR_OPERATION_CANCELLED',
  RATE_LIMITED = 'NEAR_RATE_LIMITED',
}

export class NearPluginError extends Error {
  public readonly code: NearErrorCode;
  public readonly details?: unknown;
  public readonly recoverable: boolean;

  constructor(code: NearErrorCode, message: string, details?: unknown, recoverable = false) {
    super(message);
    this.name = 'NearPluginError';
    this.code = code;
    this.details = details;
    this.recoverable = recoverable;

    // Log the error
    elizaLogger.error(`[${code}] ${message}`, details);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      recoverable: this.recoverable,
    };
  }
}

export function isNearError(error: unknown): error is NearPluginError {
  return error instanceof NearPluginError;
}

export function handleNearError(error: unknown): NearPluginError {
  if (isNearError(error)) {
    return error;
  }

  if (error instanceof Error) {
    // Parse common NEAR RPC errors
    if (error.message.includes('does not exist while viewing')) {
      return new NearPluginError(
        NearErrorCode.ACCOUNT_NOT_FOUND,
        'Account not found',
        error.message
      );
    }

    if (error.message.includes('NotEnoughBalance')) {
      return new NearPluginError(
        NearErrorCode.INSUFFICIENT_BALANCE,
        'Insufficient balance for transaction',
        error.message
      );
    }

    if (error.message.includes('NotEnoughAllowance')) {
      return new NearPluginError(
        NearErrorCode.INSUFFICIENT_GAS,
        'Insufficient gas allowance',
        error.message
      );
    }

    if (error.message.includes('slippage')) {
      return new NearPluginError(
        NearErrorCode.SLIPPAGE_EXCEEDED,
        'Slippage tolerance exceeded',
        error.message,
        true
      );
    }

    if (error.message.includes('rate limit')) {
      return new NearPluginError(
        NearErrorCode.RATE_LIMITED,
        'Rate limit exceeded',
        error.message,
        true
      );
    }

    // Generic error
    return new NearPluginError(NearErrorCode.UNKNOWN_ERROR, error.message, error);
  }

  return new NearPluginError(NearErrorCode.UNKNOWN_ERROR, 'An unknown error occurred', error);
}

export function formatErrorMessage(error: NearPluginError): string {
  switch (error.code) {
    case NearErrorCode.INSUFFICIENT_BALANCE:
      return `Insufficient balance. ${error.message}`;
    case NearErrorCode.ACCOUNT_NOT_FOUND:
      return 'Account not found. Please check the account name.';
    case NearErrorCode.NO_SWAP_ROUTE:
      return 'No swap route available. Try a different token pair.';
    case NearErrorCode.SLIPPAGE_EXCEEDED:
      return 'Price changed too much. Try increasing slippage tolerance.';
    case NearErrorCode.RATE_LIMITED:
      return 'Too many requests. Please wait a moment and try again.';
    default:
      return error.message;
  }
}
