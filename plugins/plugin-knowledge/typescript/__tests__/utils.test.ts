import { describe, it, expect } from 'vitest';
import { looksLikeBase64 } from '../src/utils';

describe('looksLikeBase64', () => {
  it('should return true for valid base64 strings', () => {
    expect(looksLikeBase64('SGVsbG8gV29ybGQ=')).toBe(true); // "Hello World"
    expect(looksLikeBase64('YW55IGNhcm5hbCBwbGVhc3VyZS4=')).toBe(true); // "any carnal pleasure."
    expect(looksLikeBase64('YW55IGNhcm5hbCBwbGVhc3VyZQ==')).toBe(true); // "any carnal pleasure"
    expect(looksLikeBase64('YW55IGNhcm5hbCBwbGVhc3Vy')).toBe(true); // "any carnal pleasur"
  });

  it('should handle whitespace in base64 strings', () => {
    expect(looksLikeBase64('SGVsbG8gV29ybGQ=\n')).toBe(true);
    expect(looksLikeBase64('SGVsbG8gV29ybGQ= ')).toBe(true);
    expect(looksLikeBase64(' SGVsbG8gV29ybGQ=')).toBe(true);
    expect(looksLikeBase64('SGVs bG8gV29ybGQ=')).toBe(true);
  });

  it('should return false for invalid base64 strings', () => {
    expect(looksLikeBase64('not base64!')).toBe(false);
    expect(looksLikeBase64('SGVsbG8gV29ybGQ')).toBe(false); // Missing padding
    expect(looksLikeBase64('SGVsbG8gV29ybGQ===')).toBe(false); // Too much padding
    expect(looksLikeBase64('SGVsbG8gV29ybGQ!')).toBe(false); // Invalid character
  });

  it('should return false for null/undefined/empty values', () => {
    expect(looksLikeBase64(null)).toBe(false);
    expect(looksLikeBase64(undefined)).toBe(false);
    expect(looksLikeBase64('')).toBe(false);
  });
});
