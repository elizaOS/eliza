import { describe, it, expect, mock, beforeEach, afterEach, jest, spyOn } from 'bun:test';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { DevServerManager } from '../../../src/commands/dev/utils/server-manager';

// Mock child_process.spawn
mock.module('node:child_process', () => ({
  spawn: jest.fn(),
}));

describe('DevServerManager', () => {
  let originalExecPath: string;
  let originalArgv: string[];
  let originalCwd: () => string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Store original process values
    originalExecPath = process.execPath;
    originalArgv = [...process.argv];
    originalCwd = process.cwd;
    originalEnv = { ...process.env };

    // Mock process values
    process.execPath = '/usr/bin/node';
    process.argv = ['/usr/bin/node', '/path/to/script.js'];
    spyOn(process, 'cwd').mockReturnValue('/workspace');

    // Mock console methods
    spyOn(console, 'info').mockImplementation(() => {});
    spyOn(console, 'warn').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});

    // Clear mock calls
    (spawn as any).mockClear();
  });

  afterEach(() => {
    // Restore original process values
    process.execPath = originalExecPath;
    process.argv = originalArgv;
    process.env = originalEnv;

    // Restore all mocks
    mock.restore();
  });

  describe('start()', () => {
    it('should handle PATH environment variable correctly when PATH exists', async () => {
      const mockSpawn = spawn as any;
      const mockChildProcess = {
        on: jest.fn(),
        kill: jest.fn(() => true),
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      // Set up env with both PATH and NODE_PATH
      process.env = {
        NODE_PATH: '/existing/node/path',
        PATH: '/usr/bin:/usr/local/bin',
      };

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
        on: jest.fn(),
        kill: jest.fn(() => true),
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      // Set up env without PATH
      process.env = {
        NODE_PATH: '/existing/node/path',
      };

      const manager = new DevServerManager();
      await manager.start();

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
      expect(env.NODE_PATH).toBe('/workspace/node_modules:/existing/node/path');
    });

    it('should handle NODE_PATH environment variable correctly when NODE_PATH is undefined', async () => {
      const mockSpawn = spawn as any;
      const mockChildProcess = {
        on: jest.fn(),
        kill: jest.fn(() => true),
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      // Set up env without NODE_PATH
      process.env = {
        PATH: '/usr/bin:/usr/local/bin',
      };

      const manager = new DevServerManager();
      await manager.start();

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
      expect(env.PATH).toBe('/workspace/node_modules/.bin:/usr/bin:/usr/local/bin');
    });

    it('should handle both PATH and NODE_PATH being undefined', async () => {
      const mockSpawn = spawn as any;
      const mockChildProcess = {
        on: jest.fn(),
        kill: jest.fn(() => true),
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      // Set up env without PATH and NODE_PATH
      process.env = {};

      const manager = new DevServerManager();
      await manager.start();

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
        on: jest.fn(),
        kill: jest.fn(() => true),
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      // Set minimal env for test
      process.env = {
        PATH: '/usr/bin:/usr/local/bin',
        NODE_PATH: '/existing/node/path',
      };

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
