import { describe, it, expect } from 'bun:test';
import {
  ClankerError,
  ErrorCode,
  handleError,
  validateAddress,
  validateAmount,
} from '../../src/utils/errors';

describe('ClankerError', () => {
  it('should create error with all properties', () => {
    const error = new ClankerError(
      ErrorCode.VALIDATION_ERROR,
      'Test error message',
      { field: 'test' },
      ['Try this', 'Or that']
    );

    expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(error.message).toBe('Test error message');
    expect(error.details).toEqual({ field: 'test' });
    expect(error.suggestions).toEqual(['Try this', 'Or that']);
  });

  it('should convert to response format', () => {
    const error = new ClankerError(ErrorCode.NETWORK_ERROR, 'Network failure');

    const response = error.toResponse();

    expect(response.code).toBe(ErrorCode.NETWORK_ERROR);
    expect(response.message).toBe('Network failure');
    expect(response.details).toBeUndefined();
    expect(response.suggestions).toBeUndefined();
  });
});

describe('handleError', () => {
  it('should handle ClankerError instances', () => {
    const error = new ClankerError(ErrorCode.SLIPPAGE_EXCEEDED, 'Slippage too high');

    const response = handleError(error);

    expect(response.code).toBe(ErrorCode.SLIPPAGE_EXCEEDED);
    expect(response.message).toBe('Slippage too high');
  });

  it('should handle insufficient funds errors', () => {
    const error = new Error('insufficient funds for gas');
    const response = handleError(error);

    expect(response.code).toBe(ErrorCode.INSUFFICIENT_BALANCE);
    expect(response.message).toContain('Insufficient balance');
    expect(response.suggestions).toBeDefined();
    expect(response.suggestions).toContain('Check your wallet balance');
  });

  it('should handle network errors', () => {
    const error = new Error('network connection timeout');
    const response = handleError(error);

    expect(response.code).toBe(ErrorCode.NETWORK_ERROR);
    expect(response.message).toContain('Network connection error');
    expect(response.suggestions).toContain('Check your internet connection');
  });

  it('should handle slippage errors', () => {
    const error = new Error('transaction would exceed slippage tolerance');
    const response = handleError(error);

    expect(response.code).toBe(ErrorCode.SLIPPAGE_EXCEEDED);
    expect(response.message).toContain('slippage tolerance');
    expect(response.suggestions).toContain('Try increasing slippage tolerance');
  });

  it('should handle transaction revert errors', () => {
    const error = new Error('transaction reverted: insufficient liquidity');
    const response = handleError(error);

    expect(response.code).toBe(ErrorCode.TRANSACTION_FAILED);
    expect(response.message).toContain('Transaction reverted');
  });

  it('should handle generic errors', () => {
    const error = 'Something went wrong';
    const response = handleError(error);

    expect(response.code).toBe(ErrorCode.PROTOCOL_ERROR);
    expect(response.message).toBe('An unexpected error occurred');
    expect(response.suggestions).toContain('Please try again');
  });
});

describe('validateAddress', () => {
  it('should validate correct Ethereum addresses', () => {
    expect(validateAddress('0x' + '1'.repeat(40))).toBe(true);
    expect(validateAddress('0x' + 'a'.repeat(40))).toBe(true);
    expect(validateAddress('0x' + 'F'.repeat(40))).toBe(true);
    expect(validateAddress('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')).toBe(true);
  });

  it('should reject invalid addresses', () => {
    expect(validateAddress('')).toBe(false);
    expect(validateAddress('0x')).toBe(false);
    expect(validateAddress('0x' + '1'.repeat(39))).toBe(false);
    expect(validateAddress('0x' + '1'.repeat(41))).toBe(false);
    expect(validateAddress('0x' + 'g'.repeat(40))).toBe(false);
    expect(validateAddress('not-an-address')).toBe(false);
  });
});

describe('validateAmount', () => {
  it('should validate valid amounts', () => {
    expect(validateAmount('0')).toBe(true);
    expect(validateAmount('1')).toBe(true);
    expect(validateAmount('1000000000000000000')).toBe(true);
    expect(validateAmount('123456789')).toBe(true);
  });

  it('should reject invalid amounts', () => {
    expect(validateAmount('')).toBe(false);
    expect(validateAmount('-1')).toBe(false);
    expect(validateAmount('1.5')).toBe(false);
    expect(validateAmount('not-a-number')).toBe(false);
    expect(validateAmount('0x123')).toBe(false);
  });
});
