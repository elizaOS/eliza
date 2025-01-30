import { describe, it, expect, vi, beforeEach } from 'vitest';
import { zgUpload } from '../../src/actions/upload';
import { type Memory, type State, type IAgentRuntime, type HandlerCallback } from '@elizaos/core';
import { FileSecurityValidator, type SecurityConfig, type ValidationResult } from '../../src/utils/security';
import { promises as fs } from 'fs';
import type { Stats } from 'fs';

// Mock dependencies
vi.mock('@elizaos/core', () => ({
  elizaLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
  composeContext: vi.fn(),
  generateObject: vi.fn().mockResolvedValue({
    filePath: '/path/to/test/file.txt'
  }),
  parseBooleanFromText: vi.fn(),
  ModelClass: {
    LARGE: 'LARGE',
  },
}));

interface MockZgFile {
  upload: vi.Mock<Promise<string>>;
  merkleTree: vi.Mock<Promise<string>>;
}

vi.mock('@0glabs/0g-ts-sdk', () => ({
  Indexer: vi.fn().mockImplementation(() => ({
    getFile: vi.fn().mockResolvedValue({}),
  })),
  ZgFile: class {
    static fromFilePath = vi.fn().mockImplementation((filePath: string): MockZgFile => ({
      upload: vi.fn().mockResolvedValue('test-file-id'),
      merkleTree: vi.fn().mockResolvedValue('test-merkle-tree'),
    }));
  },
  getFlowContract: vi.fn().mockReturnValue({
    address: '0xtest',
  }),
}));

vi.mock('fs', () => ({
  promises: {
    access: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(Buffer.from('test content')),
    unlink: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ 
      size: 1024,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      birthtime: new Date(),
      mtime: new Date(),
    } as Stats),
  },
}));

interface MockValidator {
  config: SecurityConfig;
  validateFileType: jest.Mock<Promise<ValidationResult>>;
  validateFileSize: jest.Mock<Promise<ValidationResult>>;
  validateVirusScan: jest.Mock<Promise<ValidationResult>>;
  validateFilePath: jest.Mock<Promise<ValidationResult>>;
  sanitizePath: jest.Mock<string>;
}

vi.mock('../../src/utils/security', () => {
  const validateFileType = vi.fn().mockResolvedValue<ValidationResult>({ isValid: true });
  const validateFileSize = vi.fn().mockResolvedValue<ValidationResult>({ isValid: true });
  const validateVirusScan = vi.fn().mockResolvedValue<ValidationResult>({ isValid: true });
  const validateFilePath = vi.fn().mockResolvedValue<ValidationResult>({ isValid: true });
  const sanitizePath = vi.fn().mockImplementation((filePath: string): string => filePath);
  const validateFile = vi.fn().mockResolvedValue(true);

  return {
    FileSecurityValidator: class implements MockValidator {
      constructor(config: SecurityConfig) {
        if (!config.allowedExtensions || config.allowedExtensions.length === 0) {
          throw new Error('Security configuration error: allowedExtensions must be specified');
        }
        if (!config.uploadDirectory) {
          throw new Error('Security configuration error: uploadDirectory must be specified');
        }
        if (config.maxFileSize <= 0) {
          throw new Error('Security configuration error: maxFileSize must be positive');
        }
        this.config = config;
        this.validateFileType = validateFileType;
        this.validateFileSize = validateFileSize;
        this.validateVirusScan = validateVirusScan;
        this.validateFilePath = validateFilePath;
        this.sanitizePath = sanitizePath;
      }
      config: SecurityConfig;
      validateFileType: jest.Mock<Promise<ValidationResult>>;
      validateFileSize: jest.Mock<Promise<ValidationResult>>;
      validateVirusScan: jest.Mock<Promise<ValidationResult>>;
      validateFilePath: jest.Mock<Promise<ValidationResult>>;
      sanitizePath: jest.Mock<string>;
      static validateFile = validateFile;
    },
  };
});

describe('ZG Upload Action', () => {
  let mockValidator: MockValidator;

  const mockRuntime: Required<Pick<IAgentRuntime, 'getSetting' | 'composeState' | 'updateRecentMessageState'>> = {
    getSetting: vi.fn(),
    composeState: vi.fn(),
    updateRecentMessageState: vi.fn(),
  };

  const mockMessage: Required<Pick<Memory, 'id' | 'content'>> = {
    id: 'test-message-id',
    content: {
      filePath: '/path/to/test/file.txt',
    },
  };

  const mockState: Required<Pick<State, 'messages' | 'context'>> = {
    messages: [],
    context: {},
  };

  const mockCallback: HandlerCallback = vi.fn();

  const defaultSettings: Record<string, string> = {
    ZEROG_INDEXER_RPC: 'http://indexer.test',
    ZEROG_EVM_RPC: 'http://evm.test',
    ZEROG_PRIVATE_KEY: '0xprivatekey',
    ZEROG_FLOW_ADDRESS: '0xflowaddress',
    ZEROG_MAX_FILE_SIZE: '10485760',
    ZEROG_ALLOWED_EXTENSIONS: '.pdf,.png,.jpg,.jpeg,.doc,.docx',
    ZEROG_UPLOAD_DIR: '/tmp/zerog-uploads',
    ZEROG_ENABLE_VIRUS_SCAN: 'false',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Setup default mock implementations
    mockRuntime.getSetting.mockImplementation((key: string): string => {
      const value = defaultSettings[key];
      if (value === undefined) {
        throw new Error(`Unexpected setting key: ${key}`);
      }
      return value;
    });

    mockRuntime.composeState.mockResolvedValue(mockState);
    mockRuntime.updateRecentMessageState.mockResolvedValue(mockState);

    // Create a new validator instance for each test
    const config: SecurityConfig = {
      maxFileSize: 10485760,
      allowedExtensions: ['.pdf', '.png', '.jpg', '.jpeg', '.doc', '.docx'],
      uploadDirectory: '/tmp/zerog-uploads',
      enableVirusScan: false,
    };
    mockValidator = new FileSecurityValidator(config);
  });

  describe('validate', () => {
    it('should validate successfully with correct settings', async () => {
      const result = await zgUpload.validate(mockRuntime, mockMessage);
      expect(result).toBe(true);
    });

    it('should fail validation with missing settings', async () => {
      mockRuntime.getSetting.mockReturnValue(undefined);
      const result = await zgUpload.validate(mockRuntime, mockMessage);
      expect(result).toBe(false);
    });
  });

  describe('handler', () => {
    it('should handle file upload successfully', async () => {
      const result = await zgUpload.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBeDefined();
    });

    it('should handle file validation failure', async () => {
      mockValidator.validateFileType.mockResolvedValueOnce({
        isValid: false,
        error: 'Invalid file type'
      });

      const result = await zgUpload.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(false);
      expect(mockCallback).toHaveBeenCalledWith({
        text: 'Upload failed: Invalid file type',
        content: { error: 'Invalid file type' }
      });
    });

    it('should handle file not found error', async () => {
      const error = new Error('ENOENT: no such file or directory');
      vi.mocked(fs.access).mockRejectedValueOnce(error);
      vi.mocked(fs.stat).mockRejectedValueOnce(error);

      const result = await zgUpload.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect(result).toBe(false);
      expect(mockCallback).toHaveBeenCalledWith({
        text: 'Upload failed: Could not access file',
        content: { error: 'Failed to get file stats: ENOENT: no such file or directory' }
      });
    });
  });
});
