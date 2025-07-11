import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import type { Subprocess } from 'bun';
import { 
  bunExec, 
  bunExecSimple, 
  bunExecInherit, 
  commandExists,
  ProcessExecutionError,
  ProcessTimeoutError,
  type ExecResult,
  type BunExecOptions
} from '../bun-exec';

// Mock logger
const mockLogger = {
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {})
};

// Override the logger import
mock.module('@elizaos/core', () => ({
  logger: mockLogger
}));

describe('bun-exec', () => {
  let mockProc: any;
  let originalSpawn: typeof Bun.spawn;
  
  beforeEach(() => {
    // Store original spawn
    originalSpawn = Bun.spawn;
    
    // Clear all mocks
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    
    // Default mock process
    mockProc = {
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('test output'));
          controller.close();
        }
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(''));
          controller.close();
        }
      }),
      exited: Promise.resolve(0),
      kill: mock(() => {}),
      killed: false
    };
    
    // Mock Bun.spawn
    // @ts-ignore - Mocking Bun.spawn
    Bun.spawn = mock(() => mockProc);
  });

  afterEach(() => {
    // Restore original spawn
    Bun.spawn = originalSpawn;
  });

  describe('bunExec', () => {
    it('should execute a command successfully', async () => {
      const result = await bunExec('echo', ['hello']);

      expect(result).toEqual({
        stdout: 'test output',
        stderr: '',
        exitCode: 0,
        success: true
      });

      expect(Bun.spawn).toHaveBeenCalledWith(['echo', 'hello'], {
        cwd: undefined,
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe'
      });
    });

    it('should handle command failure with non-zero exit code', async () => {
      mockProc = {
        ...mockProc,
        exited: Promise.resolve(1),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('error message'));
            controller.close();
          }
        })
      };
      // @ts-ignore
      Bun.spawn = mock(() => mockProc);

      const result = await bunExec('false');

      expect(result).toEqual({
        stdout: 'test output',
        stderr: 'error message',
        exitCode: 1,
        success: false
      });
    });

    it('should handle custom options', async () => {
      const options: BunExecOptions = {
        cwd: '/custom/path',
        env: { CUSTOM_VAR: 'value' },
        stdout: 'inherit',
        stderr: 'pipe'
      };

      await bunExec('ls', ['-la'], options);

      expect(Bun.spawn).toHaveBeenCalledWith(['ls', '-la'], {
        cwd: '/custom/path',
        env: { ...process.env, CUSTOM_VAR: 'value' },
        stdout: 'inherit',
        stderr: 'pipe'
      });
    });

    it('should handle timeout', async () => {
      mockProc = {
        ...mockProc,
        exited: new Promise(() => {}) // Never resolves
      };
      // @ts-ignore
      Bun.spawn = mock(() => mockProc);

      try {
        await bunExec('sleep', ['10'], { timeout: 100 });
        expect(false).toBe(true); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ProcessTimeoutError);
        expect(mockProc.kill).toHaveBeenCalled();
      }
    });

    it('should handle abort signal', async () => {
      mockProc = {
        ...mockProc,
        exited: new Promise((resolve) => {
          setTimeout(() => resolve(0), 200);
        })
      };
      // @ts-ignore
      Bun.spawn = mock(() => mockProc);

      const controller = new AbortController();
      const execPromise = bunExec('sleep', ['10'], { signal: controller.signal });

      // Abort after a short delay
      setTimeout(() => controller.abort(), 50);

      await execPromise;

      expect(mockProc.kill).toHaveBeenCalled();
    });

    it('should handle null stdout/stderr streams', async () => {
      mockProc = {
        ...mockProc,
        stdout: null,
        stderr: null
      };
      // @ts-ignore
      Bun.spawn = mock(() => mockProc);

      const result = await bunExec('echo', ['test']);

      expect(result).toEqual({
        stdout: '',
        stderr: '',
        exitCode: 0,
        success: true
      });
    });

    it('should handle numeric stdout/stderr (file descriptors)', async () => {
      mockProc = {
        ...mockProc,
        stdout: 1, // stdout file descriptor
        stderr: 2  // stderr file descriptor
      };
      // @ts-ignore
      Bun.spawn = mock(() => mockProc);

      const result = await bunExec('echo', ['test']);

      expect(result).toEqual({
        stdout: '',
        stderr: '',
        exitCode: 0,
        success: true
      });
    });

    it('should handle stream reading errors gracefully', async () => {
      mockProc = {
        ...mockProc,
        stdout: new ReadableStream({
          start(controller) {
            controller.error(new Error('Stream error'));
          }
        })
      };
      // @ts-ignore
      Bun.spawn = mock(() => mockProc);

      const result = await bunExec('echo', ['test']);

      // Should continue execution despite stream error
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
    });

    it('should clean up process on error', async () => {
      mockProc = {
        ...mockProc,
        exited: Promise.reject(new Error('Process error'))
      };
      // @ts-ignore
      Bun.spawn = mock(() => mockProc);

      try {
        await bunExec('bad-command');
        expect(false).toBe(true); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ProcessExecutionError);
        expect(mockProc.kill).toHaveBeenCalled();
      }
    });

    it('should handle cleanup errors gracefully', async () => {
      mockProc = {
        ...mockProc,
        kill: mock(() => {
          throw new Error('Kill failed');
        }),
        exited: Promise.reject(new Error('Process error'))
      };
      // @ts-ignore
      Bun.spawn = mock(() => mockProc);

      // Should not throw the cleanup error
      try {
        await bunExec('bad-command');
        expect(false).toBe(true); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ProcessExecutionError);
      }
    });
  });

  describe('bunExecSimple', () => {
    it('should return stdout on success', async () => {
      const result = await bunExecSimple('echo', ['hello']);

      expect(result).toEqual({ stdout: 'test output' });
    });

    it('should throw ProcessExecutionError on failure', async () => {
      mockProc = {
        ...mockProc,
        exited: Promise.resolve(1),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('error message'));
            controller.close();
          }
        })
      };
      // @ts-ignore
      Bun.spawn = mock(() => mockProc);

      try {
        await bunExecSimple('false');
        expect(false).toBe(true); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ProcessExecutionError);
      }
    });

    it('should not throw error when stdio is ignore', async () => {
      mockProc = {
        ...mockProc,
        exited: Promise.resolve(1)
      };
      // @ts-ignore
      Bun.spawn = mock(() => mockProc);

      const result = await bunExecSimple('false', [], { stdio: 'ignore' });

      expect(result).toEqual({ stdout: 'test output' });
    });
  });

  describe('bunExecInherit', () => {
    it('should use inherit stdio', async () => {
      await bunExecInherit('echo', ['hello']);

      expect(Bun.spawn).toHaveBeenCalledWith(['echo', 'hello'], {
        cwd: undefined,
        env: process.env,
        stdout: 'inherit',
        stderr: 'inherit'
      });
    });

    it('should override stdio option with inherit', async () => {
      await bunExecInherit('echo', ['hello'], { stdout: 'pipe' });

      expect(Bun.spawn).toHaveBeenCalledWith(['echo', 'hello'], {
        cwd: undefined,
        env: process.env,
        stdout: 'inherit',
        stderr: 'inherit'
      });
    });
  });

  describe('commandExists', () => {
    describe('on Unix systems', () => {
      beforeEach(() => {
        Object.defineProperty(process, 'platform', {
          value: 'linux',
          configurable: true
        });
      });

      it('should return true when command exists', async () => {
        const exists = await commandExists('node');

        expect(exists).toBe(true);
        expect(Bun.spawn).toHaveBeenCalledWith(['which', 'node'], {
          cwd: undefined,
          env: process.env,
          stdout: 'ignore',
          stderr: 'ignore'
        });
      });

      it('should return false when command does not exist', async () => {
        mockProc = {
          ...mockProc,
          exited: Promise.resolve(1)
        };
        // @ts-ignore
        Bun.spawn = mock(() => mockProc);

        const exists = await commandExists('nonexistent');

        expect(exists).toBe(false);
      });

      it('should return false on error', async () => {
        // @ts-ignore
        Bun.spawn = mock(() => {
          throw new Error('Command failed');
        });

        const exists = await commandExists('bad-command');

        expect(exists).toBe(false);
      });
    });

    describe('on Windows', () => {
      beforeEach(() => {
        Object.defineProperty(process, 'platform', {
          value: 'win32',
          configurable: true
        });
      });

      it('should use where command on Windows', async () => {
        const exists = await commandExists('node');

        expect(exists).toBe(true);
        expect(Bun.spawn).toHaveBeenCalledWith(['where', 'node'], {
          cwd: undefined,
          env: process.env,
          stdout: 'ignore',
          stderr: 'ignore'
        });
      });
    });
  });

  describe('argument escaping', () => {
    it('should handle arguments with spaces', async () => {
      await bunExec('echo', ['hello world', 'test arg']);

      // The actual command should use raw args, not escaped
      expect(Bun.spawn).toHaveBeenCalledWith(
        ['echo', 'hello world', 'test arg'],
        expect.objectContaining({})
      );
    });

    it('should handle arguments with quotes', async () => {
      await bunExec('echo', ['hello "world"', "test 'arg'"]);

      expect(Bun.spawn).toHaveBeenCalledWith(
        ['echo', 'hello "world"', "test 'arg'"],
        expect.objectContaining({})
      );
    });

    it('should handle arguments with special characters', async () => {
      await bunExec('echo', ['hello; rm -rf /', 'test$(whoami)', 'test`id`']);

      expect(Bun.spawn).toHaveBeenCalledWith(
        ['echo', 'hello; rm -rf /', 'test$(whoami)', 'test`id`'],
        expect.objectContaining({})
      );
    });

    it('should handle empty arguments', async () => {
      await bunExec('echo', ['', 'test', '']);

      expect(Bun.spawn).toHaveBeenCalledWith(
        ['echo', '', 'test', ''],
        expect.objectContaining({})
      );
    });
  });

  describe('error types', () => {
    it('should create ProcessExecutionError with correct properties', () => {
      const error = new ProcessExecutionError('Test error', 1, 'stderr output', 'test-command');

      expect(error.name).toBe('ProcessExecutionError');
      expect(error.message).toBe('Test error');
      expect(error.exitCode).toBe(1);
      expect(error.stderr).toBe('stderr output');
      expect(error.command).toBe('test-command');
    });

    it('should create ProcessTimeoutError with correct properties', () => {
      const error = new ProcessTimeoutError('Timeout error', 'test-command', 5000);

      expect(error.name).toBe('ProcessTimeoutError');
      expect(error.message).toBe('Timeout error');
      expect(error.command).toBe('test-command');
      expect(error.timeout).toBe(5000);
    });
  });
}); 