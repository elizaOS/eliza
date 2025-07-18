import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { DevServerManager } from '../../../../src/commands/dev/utils/server-manager';

// Mock child_process.spawn
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// Mock process
const mockProcess = {
  execPath: '/usr/bin/node',
  argv: ['/usr/bin/node', '/path/to/script.js'],
  cwd: vi.fn(() => '/workspace'),
  env: {
    NODE_PATH: '/existing/node/path',
    PATH: '/usr/bin:/usr/local/bin',
  },
};

// Mock console methods
const originalConsole = { ...console };
beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('DevServerManager', () => {
  describe('start()', () => {
    it('should handle PATH environment variable correctly when PATH exists', async () => {
      const mockSpawn = spawn as any;
      const mockChildProcess = {
        on: vi.fn(),
        kill: vi.fn(() => true),
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      const manager = new DevServerManager();
      await manager.start();

      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/node',
        ['/path/to/script.js', 'start'],
        expect.objectContaining({
          env: expect.objectContaining({
            PATH: expect.stringContaining('/workspace/node_modules/.bin'),
            NODE_PATH: expect.stringContaining('/workspace/node_modules'),
          }),
        })
      );

      const spawnCall = mockSpawn.mock.calls[0];
      const env = spawnCall[2].env;
      
      // Verify PATH is constructed correctly
      expect(env.PATH).toBe('/workspace/node_modules/.bin:/usr/bin:/usr/local/bin');
      expect(env.NODE_PATH).toBe('/workspace/node_modules:/existing/node/path');
    });

    it('should handle PATH environment variable correctly when PATH is undefined', async () => {
      const mockSpawn = spawn as any;
      const mockChildProcess = {
        on: vi.fn(),
        kill: vi.fn(() => true),
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      // Create a copy of process.env without PATH
      const originalEnv = { ...process.env };
      delete process.env.PATH;

      const manager = new DevServerManager();
      await manager.start();

      // Restore original env
      process.env = originalEnv;

      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/node',
        ['/path/to/script.js', 'start'],
        expect.objectContaining({
          env: expect.objectContaining({
            PATH: '/workspace/node_modules/.bin',
            NODE_PATH: expect.stringContaining('/workspace/node_modules'),
          }),
        })
      );

      const spawnCall = mockSpawn.mock.calls[0];
      const env = spawnCall[2].env;
      
      // Verify PATH is set to just the local bin path when original PATH was undefined
      expect(env.PATH).toBe('/workspace/node_modules/.bin');
      expect(env.NODE_PATH).toBe('/workspace/node_modules');
    });

    it('should handle NODE_PATH environment variable correctly when NODE_PATH is undefined', async () => {
      const mockSpawn = spawn as any;
      const mockChildProcess = {
        on: vi.fn(),
        kill: vi.fn(() => true),
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      // Create a copy of process.env without NODE_PATH
      const originalEnv = { ...process.env };
      delete process.env.NODE_PATH;

      const manager = new DevServerManager();
      await manager.start();

      // Restore original env
      process.env = originalEnv;

      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/node',
        ['/path/to/script.js', 'start'],
        expect.objectContaining({
          env: expect.objectContaining({
            PATH: expect.stringContaining('/workspace/node_modules/.bin'),
            NODE_PATH: '/workspace/node_modules',
          }),
        })
      );

      const spawnCall = mockSpawn.mock.calls[0];
      const env = spawnCall[2].env;
      
      // Verify NODE_PATH is set to just the local modules path when original NODE_PATH was undefined
      expect(env.NODE_PATH).toBe('/workspace/node_modules');
    });

    it('should handle both PATH and NODE_PATH being undefined', async () => {
      const mockSpawn = spawn as any;
      const mockChildProcess = {
        on: vi.fn(),
        kill: vi.fn(() => true),
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      // Create a copy of process.env without PATH and NODE_PATH
      const originalEnv = { ...process.env };
      delete process.env.PATH;
      delete process.env.NODE_PATH;

      const manager = new DevServerManager();
      await manager.start();

      // Restore original env
      process.env = originalEnv;

      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/node',
        ['/path/to/script.js', 'start'],
        expect.objectContaining({
          env: expect.objectContaining({
            PATH: '/workspace/node_modules/.bin',
            NODE_PATH: '/workspace/node_modules',
          }),
        })
      );

      const spawnCall = mockSpawn.mock.calls[0];
      const env = spawnCall[2].env;
      
      // Verify both are set to their respective local paths
      expect(env.PATH).toBe('/workspace/node_modules/.bin');
      expect(env.NODE_PATH).toBe('/workspace/node_modules');
    });
  });

  describe('stop()', () => {
    it('should stop the running process', async () => {
      const mockSpawn = spawn as any;
      const mockChildProcess = {
        on: vi.fn(),
        kill: vi.fn(() => true),
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      const manager = new DevServerManager();
      await manager.start();
      
      const result = await manager.stop();
      
      expect(result).toBe(true);
      expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(manager.process).toBeNull();
    });

    it('should return false when no process is running', async () => {
      const manager = new DevServerManager();
      const result = await manager.stop();
      
      expect(result).toBe(false);
    });
  });
});