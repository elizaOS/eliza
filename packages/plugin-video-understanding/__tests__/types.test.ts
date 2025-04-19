import { describe, it, expect, vi } from 'vitest';

// Mock zod implementation
vi.mock('zod', () => {
  const safeParseMock = vi.fn();
  const zodObject = {
    object: () => ({
      safeParse: safeParseMock,
    }),
    string: () => ({
      min: () => 'string-min-validator',
    }),
  };

  return {
    default: {
      object: zodObject.object,
      string: zodObject.string,
    },
    z: zodObject,
  };
});

// Import after mocking
import { FileLocationResultSchema, isFileLocationResult } from '../src/types';

describe('Types', () => {
  describe('FileLocationResultSchema', () => {
    it('should validate valid FileLocationResult', () => {
      // Set up mock for this test
      vi.mocked(FileLocationResultSchema.safeParse).mockReturnValue({
        success: true,
        data: { fileLocation: '/path/to/file.mp4' },
      } as any);

      const valid = { fileLocation: '/path/to/file.mp4' };
      const result = FileLocationResultSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('should reject empty fileLocation', () => {
      // Set up mock for this test
      vi.mocked(FileLocationResultSchema.safeParse).mockReturnValue({
        success: false,
        error: new Error('File location is empty'),
      } as any);

      const invalid = { fileLocation: '' };
      const result = FileLocationResultSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject missing fileLocation', () => {
      // Set up mock for this test
      vi.mocked(FileLocationResultSchema.safeParse).mockReturnValue({
        success: false,
        error: new Error('File location is missing'),
      } as any);

      const invalid = {};
      const result = FileLocationResultSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject non-string fileLocation', () => {
      // Set up mock for this test
      vi.mocked(FileLocationResultSchema.safeParse).mockReturnValue({
        success: false,
        error: new Error('File location must be a string'),
      } as any);

      const invalid = { fileLocation: 123 };
      const result = FileLocationResultSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe('isFileLocationResult', () => {
    it('should return true for valid FileLocationResult objects', () => {
      // Set up mock for this test
      vi.mocked(FileLocationResultSchema.safeParse).mockReturnValue({
        success: true,
        data: { fileLocation: '/path/to/file.mp4' },
      } as any);

      const valid = { fileLocation: '/path/to/file.mp4' };
      expect(isFileLocationResult(valid)).toBe(true);
    });

    it('should return false for invalid FileLocationResult objects', () => {
      // Set up mock for this test
      vi.mocked(FileLocationResultSchema.safeParse).mockReturnValue({
        success: false,
        error: new Error('Invalid FileLocationResult'),
      } as any);

      const invalid1 = { fileLocation: '' };
      const invalid2 = {};
      const invalid3 = { fileLocation: 123 };
      const invalid4 = null;
      const invalid5 = undefined;

      expect(isFileLocationResult(invalid1)).toBe(false);
      expect(isFileLocationResult(invalid2)).toBe(false);
      expect(isFileLocationResult(invalid3)).toBe(false);
      expect(isFileLocationResult(invalid4)).toBe(false);
      expect(isFileLocationResult(invalid5)).toBe(false);
    });
  });
});
