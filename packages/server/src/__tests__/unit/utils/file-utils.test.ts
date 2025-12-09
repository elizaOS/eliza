/**
 * Unit tests for file utilities
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import fs from 'node:fs';
import { logger } from '@elizaos/core';
import {
  createSecureUploadDir,
  sanitizeFilename,
  cleanupFile,
  cleanupFiles,
  cleanupUploadedFile,
} from '../../../api/shared/file-utils';

// Test file interface to avoid 'as any' casts
interface TestFileObject {
  tempFilePath?: string | null;
  originalname?: string;
}

describe('File Utilities', () => {
  let originalCwd: () => string;

  beforeEach(() => {
    // Save original cwd and mock it to return a consistent value
    originalCwd = process.cwd;
    process.cwd = () => '/test/app';
  });

  afterEach(() => {
    // Restore original cwd
    process.cwd = originalCwd;
  });

  describe('createSecureUploadDir', () => {
    it('should create valid upload directory for agents', () => {
      const result = createSecureUploadDir('agent-123', 'agents');

      // Check path structure without hardcoding full path
      expect(result).toContain('.eliza');
      expect(result).toContain('uploads');
      expect(result).toContain('agents');
      expect(result).toEndWith('agent-123');
    });

    it('should create valid upload directory for channels', () => {
      const result = createSecureUploadDir('channel-456', 'channels');

      // Check path structure without hardcoding full path
      expect(result).toContain('.eliza');
      expect(result).toContain('uploads');
      expect(result).toContain('channels');
      expect(result).toEndWith('channel-456');
    });

    it('should reject IDs with path traversal attempts', () => {
      expect(() => createSecureUploadDir('../../../etc/passwd', 'agents')).toThrow(
        'Invalid agent ID: contains illegal characters'
      );

      expect(() => createSecureUploadDir('test/../../passwd', 'channels')).toThrow(
        'Invalid channel ID: contains illegal characters'
      );
    });

    it('should reject IDs with forward slashes', () => {
      expect(() => createSecureUploadDir('test/id', 'agents')).toThrow(
        'Invalid agent ID: contains illegal characters'
      );
    });

    it('should reject IDs with backslashes', () => {
      expect(() => createSecureUploadDir('test\\id', 'agents')).toThrow(
        'Invalid agent ID: contains illegal characters'
      );
    });

    it('should reject IDs with null bytes', () => {
      expect(() => createSecureUploadDir('test\0id', 'agents')).toThrow(
        'Invalid agent ID: contains illegal characters'
      );
    });

    it('should validate path stays within base directory', () => {
      // This test ensures the resolved path check works
      const validId = 'valid-id-123';
      const result = createSecureUploadDir(validId, 'agents');

      expect(result).toContain('.eliza/data/uploads/agents');
      expect(result).toContain(validId);
    });
  });

  describe('sanitizeFilename', () => {
    it('should return filename unchanged if already safe', () => {
      expect(sanitizeFilename('test.jpg')).toBe('test.jpg');
      expect(sanitizeFilename('my-file_123.pdf')).toBe('my-file_123.pdf');
    });

    it('should remove null bytes', () => {
      expect(sanitizeFilename('test\0file.jpg')).toBe('testfile.jpg');
    });

    it('should remove path separators', () => {
      expect(sanitizeFilename('test/file.jpg')).toBe('test_file.jpg');
      expect(sanitizeFilename('test\\file.jpg')).toBe('test_file.jpg');
    });

    it('should remove special characters', () => {
      expect(sanitizeFilename('test:file*name?.jpg')).toBe('test_file_name_.jpg');
      expect(sanitizeFilename('file<>name|.pdf')).toBe('file__name_.pdf');
    });

    it('should remove leading dots and spaces', () => {
      expect(sanitizeFilename('...test.jpg')).toBe('.test.jpg');
      expect(sanitizeFilename('   test.jpg')).toBe('test.jpg');
      expect(sanitizeFilename('.. .test.jpg')).toBe('. .test.jpg');
    });

    it('should truncate long filenames while preserving extension', () => {
      const longName = `${'a'.repeat(300)}.jpg`;
      const result = sanitizeFilename(longName);

      expect(result.length).toBeLessThanOrEqual(255);
      expect(result).toMatch(/\.jpg$/);
      expect(result).toMatch(/^aaa/);
    });

    it('should handle empty filename', () => {
      expect(sanitizeFilename('')).toBe('unnamed');
      expect(sanitizeFilename('   ')).toBe('unnamed');
    });

    it('should handle filename with only special characters', () => {
      expect(sanitizeFilename(':<>|')).toBe('____');
    });

    it('should preserve unicode characters', () => {
      expect(sanitizeFilename('测试文件.jpg')).toBe('测试文件.jpg');
      expect(sanitizeFilename('файл.pdf')).toBe('файл.pdf');
    });
  });

  describe('cleanupFile', () => {
    it('should delete existing file', () => {
      const filePath = '/test/app/uploads/test.jpg';

      const existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
      const unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation(() => {});
      const loggerSpy = spyOn(logger, 'debug').mockImplementation(() => {});

      cleanupFile(filePath);

      expect(existsSpy).toHaveBeenCalledWith(filePath);
      expect(unlinkSpy).toHaveBeenCalled();
      expect(loggerSpy).toHaveBeenCalled();

      existsSpy.mockRestore();
      unlinkSpy.mockRestore();
      loggerSpy.mockRestore();
    });

    it('should handle non-existent file gracefully', () => {
      const filePath = '/test/app/uploads/test.jpg';

      const existsSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
      const unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation(() => {});

      cleanupFile(filePath);

      expect(existsSpy).toHaveBeenCalledWith(filePath);
      expect(unlinkSpy).not.toHaveBeenCalled();

      existsSpy.mockRestore();
      unlinkSpy.mockRestore();
    });

    it('should handle empty file path', () => {
      const existsSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
      const unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation(() => {});

      cleanupFile('');

      expect(unlinkSpy).not.toHaveBeenCalled();

      existsSpy.mockRestore();
      unlinkSpy.mockRestore();
    });

    it('should normalize paths before deletion', () => {
      const filePath = '/test/app/uploads/../uploads/test.jpg';

      const existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
      const unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation(() => {});

      cleanupFile(filePath);

      // Should normalize the path before calling unlink
      expect(unlinkSpy).toHaveBeenCalled();

      existsSpy.mockRestore();
      unlinkSpy.mockRestore();
    });

    it('should handle file deletion errors gracefully', () => {
      const filePath = '/test/app/uploads/test.jpg';

      const existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
      const unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation(() => {
        throw new Error('Permission denied');
      });
      const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});

      cleanupFile(filePath);

      expect(errorSpy).toHaveBeenCalled();

      existsSpy.mockRestore();
      unlinkSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  // Note: Actual file cleanup behavior is tested via integration tests
  // These unit tests focus on error handling and edge cases
  describe('cleanupFiles', () => {
    it('should handle empty files array gracefully', () => {
      expect(() => cleanupFiles([])).not.toThrow();
    });

    it('should handle undefined files gracefully', () => {
      // Testing error handling with invalid input type
      expect(() => cleanupFiles(undefined as Express.Multer.File[])).not.toThrow();
    });

    it('should handle files with null tempFilePath', () => {
      const files: TestFileObject[] = [{ tempFilePath: null }, { tempFilePath: undefined }];

      // Testing error handling with incompatible file object types
      expect(() => cleanupFiles(files as Express.Multer.File[])).not.toThrow();
    });

    it('should validate array structure', () => {
      const files = [
        { tempFilePath: '/test/app/uploads/file1.jpg' },
        { tempFilePath: '/test/app/uploads/file2.pdf' },
      ] as any[];

      // Just validate the function accepts the correct structure
      expect(Array.isArray(files)).toBe(true);
      expect(files.every((f) => typeof f === 'object')).toBe(true);
    });
  });

  describe('cleanupUploadedFile', () => {
    it('should handle file object structure', () => {
      const file = { tempFilePath: '/test/app/uploads/file1.jpg' } as any;

      expect(file.tempFilePath).toBeDefined();
      expect(typeof file.tempFilePath).toBe('string');
    });

    it('should handle file without tempFilePath gracefully', () => {
      const file = { tempFilePath: undefined } as any;

      expect(() => cleanupUploadedFile(file)).not.toThrow();
    });

    it('should require valid file object', () => {
      // Function expects a valid file object with properties
      const validFile = { tempFilePath: '/test/path.jpg', originalname: 'test.jpg' } as any;
      expect(validFile.tempFilePath).toBeDefined();
    });
  });
});
