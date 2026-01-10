import type { ChildProcess, ExecException, ExecOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { type IAgentRuntime, ModelType, type Plugin, logger } from '@elizaos/core';
import type { IOptions } from 'nodejs-whisper';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { TEST_PATHS, createMockRuntime } from './test-utils';

// Mock the nodewhisper function
vi.mock('nodejs-whisper', () => {
  logger.info('Setting up nodewhisper mock');
  return {
    nodewhisper: vi.fn().mockImplementation(async (filePath: string, options: IOptions) => {
      logger.info('nodewhisper mock called with:', {
        filePath,
        options,
        fileExists: fs.existsSync(filePath),
      });

      // Mock successful transcription
      if (fs.existsSync(filePath)) {
        logger.success('Mock transcription successful');
        return 'This is a mock transcription of the audio file.';
      }
      logger.error('Audio file not found in mock');
      throw new Error('Audio file not found');
    }),
  };
});

// Mock the exec function for audio conversion
vi.mock('node:child_process', () => {
  logger.info('Setting up child_process exec mock');
  return {
    exec: vi
      .fn()
      .mockImplementation(
        (
          command: string,
          options:
            | ExecOptions
            | undefined
            | null
            | ((error: ExecException | null, stdout: string, stderr: string) => void),
          callback?: (error: ExecException | null, stdout: string, stderr: string) => void
        ) => {
          logger.info('exec mock called with:', {
            command,
            hasOptions: !!options,
            optionsType: typeof options,
            hasCallback: !!callback,
          });

          // Handle the case where options is the callback
          const actualCallback = callback || (typeof options === 'function' ? options : undefined);
          if (actualCallback) {
            logger.info('Executing mock ffmpeg conversion');
            actualCallback(null, '', '');
          }
          return { kill: () => {}, pid: 123 } as ChildProcess;
        }
      ),
  };
});

// Set environment variables before importing the plugin
process.env.MODELS_DIR = TEST_PATHS.MODELS_DIR;
process.env.CACHE_DIR = TEST_PATHS.CACHE_DIR;

// Import plugin after setting environment variables and mocks
import { localAiPlugin } from '../src/index';

// Type assertion for localAIPlugin
const plugin = localAiPlugin as Required<Plugin>;

describe('LocalAI Audio Transcription', () => {
  const mockRuntime = createMockRuntime();

  beforeAll(async () => {
    logger.info('Starting transcription test setup', {
      MODELS_DIR: TEST_PATHS.MODELS_DIR,
      CACHE_DIR: TEST_PATHS.CACHE_DIR,
      process_cwd: process.cwd(),
    });

    // Create necessary directories
    const whisperCacheDir = path.join(TEST_PATHS.CACHE_DIR, 'whisper');
    if (!fs.existsSync(whisperCacheDir)) {
      logger.info('Creating whisper cache directory:', whisperCacheDir);
      fs.mkdirSync(whisperCacheDir, { recursive: true });
    }

    await plugin.init(
      {
        MODELS_DIR: TEST_PATHS.MODELS_DIR,
        CACHE_DIR: TEST_PATHS.CACHE_DIR,
      },
      mockRuntime as IAgentRuntime
    );

    logger.success('Test setup completed');
  }, 300000);

  test('should transcribe audio buffer successfully', async () => {
    logger.info('Starting successful transcription test');

    // Create a mock audio buffer (WAV header)
    const audioBuffer = Buffer.from([
      0x52,
      0x49,
      0x46,
      0x46, // "RIFF"
      0x24,
      0x00,
      0x00,
      0x00, // Chunk size
      0x57,
      0x41,
      0x56,
      0x45, // "WAVE"
      0x66,
      0x6d,
      0x74,
      0x20, // "fmt "
    ]);

    logger.info('Created test audio buffer', {
      size: audioBuffer.length,
      header: audioBuffer.toString('hex').substring(0, 32),
    });

    const result = await mockRuntime.useModel(ModelType.TRANSCRIPTION, audioBuffer);

    logger.info('Transcription result:', {
      result,
      type: typeof result,
      length: result.length,
    });

    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result).toContain('transcription');
    logger.success('Successful transcription test completed');
  });

  test('should handle empty audio buffer', async () => {
    logger.info('Starting empty buffer test');
    const emptyBuffer = Buffer.from([]);

    logger.info('Created empty buffer', {
      size: emptyBuffer.length,
    });

    try {
      await mockRuntime.useModel(ModelType.TRANSCRIPTION, emptyBuffer);
      throw new Error("Should have failed but didn't");
    } catch (error) {
      logger.info('Empty buffer test failed as expected:', {
        error: error instanceof Error ? error.message : String(error),
      });
      expect(error).toBeDefined();
    }
  });

  test('should handle invalid audio format', async () => {
    logger.info('Starting invalid format test');
    const invalidBuffer = Buffer.from('not an audio file');

    logger.info('Created invalid buffer', {
      size: invalidBuffer.length,
      content: invalidBuffer.toString(),
    });

    try {
      await mockRuntime.useModel(ModelType.TRANSCRIPTION, invalidBuffer);
      throw new Error("Should have failed but didn't");
    } catch (error) {
      logger.info('Invalid format test failed as expected:', {
        error: error instanceof Error ? error.message : String(error),
      });
      expect(error).toBeDefined();
    }
  });

  test('should handle audio conversion failure', async () => {
    logger.info('Starting conversion failure test');

    const { exec } = await import('node:child_process');
    const execMock = vi.mocked(exec);

    logger.info('Setting up failing exec mock');
    execMock.mockImplementationOnce(
      (
        command: string,
        options:
          | ExecOptions
          | undefined
          | null
          | ((error: ExecException | null, stdout: string, stderr: string) => void),
        callback?: (error: ExecException | null, stdout: string, stderr: string) => void
      ) => {
        logger.info('Failing exec mock called with:', {
          command,
          hasOptions: !!options,
          hasCallback: !!callback,
        });

        const actualCallback = callback || (typeof options === 'function' ? options : undefined);
        if (actualCallback) {
          const error = new Error('Failed to convert audio') as ExecException;
          error.code = 1;
          error.killed = false;
          logger.info('Simulating ffmpeg failure');
          actualCallback(error, '', '');
        }
        return { kill: () => {}, pid: 123 } as ChildProcess;
      }
    );

    const audioBuffer = Buffer.from([
      0x52,
      0x49,
      0x46,
      0x46, // "RIFF"
      0x24,
      0x00,
      0x00,
      0x00, // Chunk size
    ]);

    logger.info('Created test audio buffer for conversion failure', {
      size: audioBuffer.length,
      header: audioBuffer.toString('hex').substring(0, 16),
    });

    try {
      await mockRuntime.useModel(ModelType.TRANSCRIPTION, audioBuffer);
      throw new Error("Should have failed but didn't");
    } catch (error) {
      logger.info('Conversion failure test failed as expected:', {
        error: error instanceof Error ? error.message : String(error),
      });
      expect(error).toBeDefined();
      expect(error.message).toContain('Failed to convert audio');
    }
  });

  test('should handle whisper model failure', async () => {
    logger.info('Starting whisper model failure test');

    const { nodewhisper } = await import('nodejs-whisper');
    const whisperMock = vi.mocked(nodewhisper);

    logger.info('Setting up failing whisper mock');
    whisperMock.mockRejectedValueOnce(new Error('Whisper model failed'));

    const audioBuffer = Buffer.from([
      0x52,
      0x49,
      0x46,
      0x46, // "RIFF"
      0x24,
      0x00,
      0x00,
      0x00, // Chunk size
    ]);

    logger.info('Created test audio buffer for whisper failure', {
      size: audioBuffer.length,
      header: audioBuffer.toString('hex').substring(0, 16),
    });

    try {
      await mockRuntime.useModel(ModelType.TRANSCRIPTION, audioBuffer);
      throw new Error("Should have failed but didn't");
    } catch (error) {
      logger.info('Whisper failure test failed as expected:', {
        error: error instanceof Error ? error.message : String(error),
      });
      expect(error).toBeDefined();
      expect(error.message).toContain('Whisper model failed');
    }
  });

  test('should clean up temporary files after transcription', async () => {
    logger.info('Starting cleanup test');

    const audioBuffer = Buffer.from([
      0x52,
      0x49,
      0x46,
      0x46, // "RIFF"
      0x24,
      0x00,
      0x00,
      0x00, // Chunk size
      0x57,
      0x41,
      0x56,
      0x45, // "WAVE"
    ]);

    logger.info('Created test audio buffer for cleanup test', {
      size: audioBuffer.length,
      header: audioBuffer.toString('hex').substring(0, 24),
    });

    await mockRuntime.useModel(ModelType.TRANSCRIPTION, audioBuffer);

    // Check that no temporary files are left in the cache directory
    const cacheDir = path.join(TEST_PATHS.CACHE_DIR, 'whisper');
    logger.info('Checking cache directory for temp files:', cacheDir);

    const files = fs.readdirSync(cacheDir);
    logger.info('Found files in cache:', files);

    const tempFiles = files.filter((f) => f.startsWith('temp_'));
    logger.info('Found temporary files:', tempFiles);

    expect(tempFiles.length).toBe(0);
    logger.success('Cleanup test completed');
  });
});
