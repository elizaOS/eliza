import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildProject } from '../../../src/utils/build-project';
import { logger } from '@elizaos/core';
import * as execa from 'execa';
import * as fs from 'node:fs';

// Mock dependencies
vi.mock('@elizaos/core', () => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn()
  }
}));

vi.mock('execa');

vi.mock('node:fs', () => ({
  existsSync: vi.fn()
}));

describe('buildProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should build project with bun when build script exists', async () => {
    const mockExecaCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
    vi.mocked(execa).execaCommand = mockExecaCommand;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    
    await buildProject('/test/project');
    
    expect(logger.info).toHaveBeenCalledWith('Building project...');
    expect(mockExecaCommand).toHaveBeenCalledWith(
      'bun run build',
      expect.objectContaining({
        cwd: '/test/project',
        stdio: 'inherit',
        shell: true
      })
    );
    expect(logger.success).toHaveBeenCalledWith('Build completed successfully!');
  });

  it('should build plugin with bun when isPlugin is true', async () => {
    const mockExecaCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
    vi.mocked(execa).execaCommand = mockExecaCommand;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    
    await buildProject('/test/plugin', true);
    
    expect(logger.info).toHaveBeenCalledWith('Building plugin...');
    expect(mockExecaCommand).toHaveBeenCalledWith(
      'bun run build',
      expect.objectContaining({
        cwd: '/test/plugin'
      })
    );
    expect(logger.success).toHaveBeenCalledWith('Build completed successfully!');
  });

  it('should skip build when no build script exists', async () => {
    const mockExecaCommand = vi.fn();
    vi.mocked(execa).execaCommand = mockExecaCommand;
    vi.mocked(fs.existsSync).mockReturnValue(false);
    
    await buildProject('/test/project');
    
    expect(logger.warn).toHaveBeenCalledWith('No build script found in package.json, skipping build...');
    expect(mockExecaCommand).not.toHaveBeenCalled();
  });

  it('should handle build errors', async () => {
    const mockError = new Error('Build failed');
    const mockExecaCommand = vi.fn().mockRejectedValue(mockError);
    vi.mocked(execa).execaCommand = mockExecaCommand;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    
    await expect(buildProject('/test/project')).rejects.toThrow('Build failed');
    
    expect(logger.error).toHaveBeenCalledWith('Build failed:', mockError);
  });

  it('should handle non-zero exit code', async () => {
    const mockExecaCommand = vi.fn().mockResolvedValue({ exitCode: 1 });
    vi.mocked(execa).execaCommand = mockExecaCommand;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    
    await expect(buildProject('/test/project')).rejects.toThrow('Build failed with exit code 1');
    
    expect(logger.error).toHaveBeenCalledWith('Build failed with exit code 1');
  });

  it('should set NODE_ENV to production', async () => {
    const mockExecaCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
    vi.mocked(execa).execaCommand = mockExecaCommand;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    
    await buildProject('/test/project');
    
    expect(mockExecaCommand).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        env: expect.objectContaining({
          NODE_ENV: 'production'
        })
      })
    );
  });

  it('should pass projectPath correctly', async () => {
    const mockExecaCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
    vi.mocked(execa).execaCommand = mockExecaCommand;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    
    const testPath = '/custom/project/path';
    await buildProject(testPath);
    
    expect(mockExecaCommand).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        cwd: testPath
      })
    );
  });
}); 