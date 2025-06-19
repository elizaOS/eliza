import { describe, it, expect } from 'bun:test';
import { validatePort } from '../../../src/utils/port-validation';

describe('validatePort', () => {
  it('should return valid port number as number', () => {
    expect(validatePort('3000')).toBe(3000);
    expect(validatePort('8080')).toBe(8080);
    expect(validatePort('65535')).toBe(65535);
    expect(validatePort('1')).toBe(1);
  });

  it('should throw error for port number 0', () => {
    expect(() => validatePort('0')).toThrow('Port must be a number between 1 and 65535');
  });

  it('should throw error for negative port numbers', () => {
    expect(() => validatePort('-1')).toThrow('Port must be a number between 1 and 65535');
    expect(() => validatePort('-8080')).toThrow('Port must be a number between 1 and 65535');
  });

  it('should throw error for port numbers above 65535', () => {
    expect(() => validatePort('65536')).toThrow('Port must be a number between 1 and 65535');
    expect(() => validatePort('70000')).toThrow('Port must be a number between 1 and 65535');
    expect(() => validatePort('999999')).toThrow('Port must be a number between 1 and 65535');
  });

  it('should throw error for non-numeric input', () => {
    expect(() => validatePort('abc')).toThrow('Port must be a number between 1 and 65535');
    expect(validatePort('3000abc')).toBe(3000);
    expect(() => validatePort('!@#$')).toThrow('Port must be a number between 1 and 65535');
    expect(() => validatePort('')).toThrow('Port must be a number between 1 and 65535');
    expect(() => validatePort(' ')).toThrow('Port must be a number between 1 and 65535');
  });

  it('should handle decimal numbers correctly', () => {
    expect(validatePort('3000.5')).toBe(3000);
    expect(validatePort('8080.0')).toBe(8080);
  });

  it('should handle string with spaces correctly', () => {
    expect(validatePort(' 3000 ')).toBe(3000);
    expect(validatePort('30 00')).toBe(30);
  });

  it('should handle special number formats correctly', () => {
    expect(validatePort('1e3')).toBe(1);
    expect(() => validatePort('0x1234')).toThrow('Port must be a number between 1 and 65535');
    expect(() => validatePort('Infinity')).toThrow('Port must be a number between 1 and 65535');
  });
});
