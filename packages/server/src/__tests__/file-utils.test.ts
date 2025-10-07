/**
 * Unit tests for file utilities
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  createSecureUploadDir,
  sanitizeFilename,
  cleanupFile,
  cleanupFiles,
  cleanupUploadedFile,
} from '../api/shared/file-utils';
import path from 'node:path';

// Mock dependencies
const fsMock = {
  existsSync: mock(),
  unlinkSync: mock(),
};

const loggerMock = {
  info: mock(),
  debug: mock(),
  warn: mock(),
  error: mock(),
};

mock.module('fs', () => ({
  default: fsMock,
}));

mock.module('@elizaos/core', async () => {
  const actual = await import('@elizaos/core');
  return {
    ...actual,
    logger: loggerMock,
  };
});

describe('File Utilities', () => {
  beforeEach(() => {
    // Reset mocks before each test
    fsMock.existsSync.mockReturnValue(false);
    fsMock.unlinkSync.mockReset();
    loggerMock.debug.mockReset();
    loggerMock.error.mockReset();
    loggerMock.warn.mockReset();

    // Mock process.cwd() to return a consistent value
    process.cwd = () => '/test/app';
  });

  afterEach(() => {
    // Clean up mocks after each test
  });

  describe('createSecureUploadDir', () => {
    it('should create valid upload directory for agents', () => {
      const result = createSecureUploadDir('agent-123', 'agents');

      expect(result).toBe(
        path.resolve('/test/app', '.eliza', 'data', 'uploads', 'agents', 'agent-123')
      );
    });

    it('should create valid upload directory for channels', () => {
      const result = createSecureUploadDir('channel-456', 'channels');

      expect(result).toBe(
        path.resolve('/test/app', '.eliza', 'data', 'uploads', 'channels', 'channel-456')
      );
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
      fsMock.existsSync.mockReturnValue(true);

      cleanupFile(filePath);

      expect(fsMock.unlinkSync).toHaveBeenCalledWith(path.resolve(filePath));
      expect(loggerMock.debug).toHaveBeenCalledWith(
        expect.stringContaining('Successfully cleaned up file')
      );
    });

    it('should handle non-existent file gracefully', () => {
      const filePath = '/test/app/uploads/test.jpg';
      fsMock.existsSync.mockReturnValue(false);

      cleanupFile(filePath);

      expect(fsMock.unlinkSync).not.toHaveBeenCalled();
    });

    it('should handle empty file path', () => {
      cleanupFile('');

      expect(fsMock.existsSync).not.toHaveBeenCalled();
      expect(fsMock.unlinkSync).not.toHaveBeenCalled();
    });

    it('should block path traversal attempts', () => {
      const maliciousPath = '../../../etc/passwd';

      cleanupFile(maliciousPath);

      expect(fsMock.unlinkSync).not.toHaveBeenCalled();
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining('Potentially unsafe file path blocked')
      );
    });

    it('should block paths outside of app directory', () => {
      const outsidePath = '/etc/passwd';

      cleanupFile(outsidePath);

      expect(fsMock.unlinkSync).not.toHaveBeenCalled();
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining('Potentially unsafe file path blocked')
      );
    });

    it('should handle file deletion errors', () => {
      const filePath = '/test/app/uploads/test.jpg';
      fsMock.existsSync.mockReturnValue(true);
      fsMock.unlinkSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      cleanupFile(filePath);

      expect(loggerMock.error).toHaveBeenCalledWith(
        expect.stringContaining('Error cleaning up file'),
        expect.any(Error)
      );
    });

    it('should normalize paths before checking', () => {
      const filePath = '/test/app/uploads/../uploads/test.jpg';
      fsMock.existsSync.mockReturnValue(true);

      cleanupFile(filePath);

      // Should normalize to /test/app/uploads/test.jpg
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(path.resolve('/test/app/uploads/test.jpg'));
    });
  });

  describe('cleanupFiles', () => {
    it('should cleanup multiple files', () => {
      const files = [
        { tempFilePath: '/test/app/uploads/file1.jpg' },
        { tempFilePath: '/test/app/uploads/file2.pdf' },
        { tempFilePath: '/test/app/uploads/file3.mp3' },
      ] as any[];

      fsMock.existsSync.mockReturnValue(true);

      cleanupFiles(files);

      expect(fsMock.unlinkSync).toHaveBeenCalledTimes(3);
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(path.resolve(files[0].tempFilePath));
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(path.resolve(files[1].tempFilePath));
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(path.resolve(files[2].tempFilePath));
    });

    it('should handle empty files array', () => {
      cleanupFiles([]);

      expect(fsMock.unlinkSync).not.toHaveBeenCalled();
    });

    it('should handle undefined files', () => {
      cleanupFiles(undefined as any);

      expect(fsMock.unlinkSync).not.toHaveBeenCalled();
    });

    it('should handle files without tempFilePath', () => {
      const files = [
        { tempFilePath: '/test/app/uploads/file1.jpg' },
        { tempFilePath: undefined },
        { tempFilePath: '/test/app/uploads/file3.mp3' },
      ] as any[];

      fsMock.existsSync.mockReturnValue(true);

      cleanupFiles(files);

      expect(fsMock.unlinkSync).toHaveBeenCalledTimes(2);
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(path.resolve(files[0].tempFilePath));
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(path.resolve(files[2].tempFilePath));
    });

    it('should continue cleanup even if one file fails', () => {
      const files = [
        { tempFilePath: '/test/app/uploads/file1.jpg' },
        { tempFilePath: '/test/app/uploads/file2.pdf' },
        { tempFilePath: '/test/app/uploads/file3.mp3' },
      ] as any[];

      fsMock.existsSync.mockReturnValue(true);
      fsMock.unlinkSync
        .mockImplementationOnce(() => {}) // Success
        .mockImplementationOnce(() => {
          throw new Error('Permission denied');
        }) // Fail
        .mockImplementationOnce(() => {}); // Success

      cleanupFiles(files);

      expect(fsMock.unlinkSync).toHaveBeenCalledTimes(3);
      expect(loggerMock.error).toHaveBeenCalled();
    });
  });

  describe('cleanupUploadedFile', () => {
    it('should cleanup a single uploaded file', () => {
      const file = { tempFilePath: '/test/app/uploads/file1.jpg' } as any;

      fsMock.existsSync.mockReturnValue(true);

      cleanupUploadedFile(file);

      expect(fsMock.unlinkSync).toHaveBeenCalledWith(path.resolve(file.tempFilePath));
    });

    it('should handle file without tempFilePath', () => {
      const file = { tempFilePath: undefined } as any;

      cleanupUploadedFile(file);

      expect(fsMock.unlinkSync).not.toHaveBeenCalled();
    });
  });
});
