/**
 * Unit tests for file utilities
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  createSecureUploadDir,
  sanitizeFilename,
  cleanupFile,
  cleanupFiles,
} from '../api/shared/file-utils';
import fs from 'fs';
import path from 'path';
import { logger } from '@elizaos/core';

// Mock dependencies
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

vi.mock('@elizaos/core', async () => {
  const actual = await vi.importActual('@elizaos/core');
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

describe('File Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock process.cwd() to return a consistent value
    vi.spyOn(process, 'cwd').mockReturnValue('/test/app');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createSecureUploadDir', () => {
    it('should create valid upload directory for agents', () => {
      const result = createSecureUploadDir('/test/app', 'agent-123', 'agents');

      expect(result).toBe(
        path.resolve('/test/app', '.eliza', 'data', 'uploads', 'agents', 'agent-123')
      );
    });

    it('should create valid upload directory for channels', () => {
      const result = createSecureUploadDir('/test/app', 'channel-456', 'channels');

      expect(result).toBe(
        path.resolve('/test/app', '.eliza', 'data', 'uploads', 'channels', 'channel-456')
      );
    });

    it('should reject IDs with path traversal attempts', () => {
      expect(() => createSecureUploadDir('/test/app', '../../../etc/passwd', 'agents')).toThrow(
        'Invalid agent ID: contains illegal characters'
      );

      expect(() => createSecureUploadDir('/test/app', 'test/../../passwd', 'channels')).toThrow(
        'Invalid channel ID: contains illegal characters'
      );
    });

    it('should reject IDs with forward slashes', () => {
      expect(() => createSecureUploadDir('/test/app', 'test/id', 'agents')).toThrow(
        'Invalid agent ID: contains illegal characters'
      );
    });

    it('should reject IDs with backslashes', () => {
      expect(() => createSecureUploadDir('/test/app', 'test\\id', 'agents')).toThrow(
        'Invalid agent ID: contains illegal characters'
      );
    });

    it('should reject IDs with null bytes', () => {
      expect(() => createSecureUploadDir('/test/app', 'test\0id', 'agents')).toThrow(
        'Invalid agent ID: contains illegal characters'
      );
    });

    it('should validate path stays within base directory', () => {
      // This test ensures the resolved path check works
      const validId = 'valid-id-123';
      const result = createSecureUploadDir('/test/app', validId, 'agents');

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
      expect(sanitizeFilename('test\0file.jpg')).toBe('test_file.jpg');
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
      expect(sanitizeFilename('...test.jpg')).toBe('test.jpg');
      expect(sanitizeFilename('   test.jpg')).toBe('test.jpg');
      expect(sanitizeFilename('.. .test.jpg')).toBe('test.jpg');
    });

    it('should truncate long filenames while preserving extension', () => {
      const longName = 'a'.repeat(300) + '.jpg';
      const result = sanitizeFilename(longName);

      expect(result.length).toBeLessThanOrEqual(255);
      expect(result).toMatch(/\.jpg$/);
      expect(result).toMatch(/^aaa/);
    });

    it('should handle empty filename', () => {
      expect(sanitizeFilename('')).toBe('file');
      expect(sanitizeFilename('   ')).toBe('file');
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
      (fs.existsSync as any).mockReturnValue(true);

      cleanupFile(filePath);

      expect(fs.unlinkSync).toHaveBeenCalledWith(path.resolve(filePath));
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Successfully cleaned up file')
      );
    });

    it('should handle non-existent file gracefully', () => {
      const filePath = '/test/app/uploads/test.jpg';
      (fs.existsSync as any).mockReturnValue(false);

      cleanupFile(filePath);

      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('should handle empty file path', () => {
      cleanupFile('');

      expect(fs.existsSync).not.toHaveBeenCalled();
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('should block path traversal attempts', () => {
      const maliciousPath = '../../../etc/passwd';

      cleanupFile(maliciousPath);

      expect(fs.unlinkSync).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Potentially unsafe file path blocked')
      );
    });

    it('should block paths outside of app directory', () => {
      const outsidePath = '/etc/passwd';

      cleanupFile(outsidePath);

      expect(fs.unlinkSync).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Potentially unsafe file path blocked')
      );
    });

    it('should handle file deletion errors', () => {
      const filePath = '/test/app/uploads/test.jpg';
      (fs.existsSync as any).mockReturnValue(true);
      (fs.unlinkSync as any).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      cleanupFile(filePath);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error cleaning up file'),
        expect.any(Error)
      );
    });

    it('should normalize paths before checking', () => {
      const filePath = '/test/app/uploads/../uploads/test.jpg';
      (fs.existsSync as any).mockReturnValue(true);

      cleanupFile(filePath);

      // Should normalize to /test/app/uploads/test.jpg
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.resolve('/test/app/uploads/test.jpg'));
    });
  });

  describe('cleanupFiles', () => {
    it('should cleanup multiple files', () => {
      const files = [
        { path: '/test/app/uploads/file1.jpg' },
        { path: '/test/app/uploads/file2.pdf' },
        { path: '/test/app/uploads/file3.mp3' },
      ] as Express.Multer.File[];

      (fs.existsSync as any).mockReturnValue(true);

      cleanupFiles(files);

      expect(fs.unlinkSync).toHaveBeenCalledTimes(3);
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.resolve(files[0].path));
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.resolve(files[1].path));
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.resolve(files[2].path));
    });

    it('should handle empty files array', () => {
      cleanupFiles([]);

      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('should handle undefined files', () => {
      cleanupFiles(undefined as any);

      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('should continue cleanup even if one file fails', () => {
      const files = [
        { path: '/test/app/uploads/file1.jpg' },
        { path: '/test/app/uploads/file2.pdf' },
        { path: '/test/app/uploads/file3.mp3' },
      ] as Express.Multer.File[];

      (fs.existsSync as any).mockReturnValue(true);
      (fs.unlinkSync as any)
        .mockImplementationOnce(() => {}) // Success
        .mockImplementationOnce(() => {
          throw new Error('Permission denied');
        }) // Fail
        .mockImplementationOnce(() => {}); // Success

      cleanupFiles(files);

      expect(fs.unlinkSync).toHaveBeenCalledTimes(3);
      expect(logger.error).toHaveBeenCalledOnce();
    });
  });
});
