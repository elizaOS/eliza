import { describe, expect, it } from 'vitest';
import { FileLocationResultSchema, isFileLocationResult } from '../src/types';

describe('FileLocationResultSchema', () => {
  it('should validate a valid FileLocationResult', () => {
    const result = FileLocationResultSchema.safeParse({
      fileLocation: '/path/to/file.txt',
    });
    expect(result.success).toBe(true);
  });

  it('should reject an object with missing fileLocation', () => {
    const result = FileLocationResultSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('should reject an object with empty fileLocation', () => {
    const result = FileLocationResultSchema.safeParse({
      fileLocation: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject an object with non-string fileLocation', () => {
    const result = FileLocationResultSchema.safeParse({
      fileLocation: 123,
    });
    expect(result.success).toBe(false);
  });
});

describe('isFileLocationResult', () => {
  it('should return true for a valid FileLocationResult', () => {
    const result = isFileLocationResult({
      fileLocation: '/path/to/file.txt',
    });
    expect(result).toBe(true);
  });

  it('should return false for an object with missing fileLocation', () => {
    const result = isFileLocationResult({});
    expect(result).toBe(false);
  });

  it('should return false for an object with empty fileLocation', () => {
    const result = isFileLocationResult({
      fileLocation: '',
    });
    expect(result).toBe(false);
  });

  it('should return false for null', () => {
    const result = isFileLocationResult(null);
    expect(result).toBe(false);
  });

  it('should return false for undefined', () => {
    const result = isFileLocationResult(undefined);
    expect(result).toBe(false);
  });

  it('should return false for a number', () => {
    const result = isFileLocationResult(123);
    expect(result).toBe(false);
  });

  it('should return false for a string', () => {
    const result = isFileLocationResult('not an object');
    expect(result).toBe(false);
  });
});
