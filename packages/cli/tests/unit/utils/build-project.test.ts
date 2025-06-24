import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { buildProject } from '../../../src/utils/build-project';

// Mock dependencies with proper typing
const mockLogger = {
  info: mock(),
  success: mock(),
  error: mock(),
  warn: mock(),
  debug: mock(),
};

const mockExeca = mock();
const mockRunBunCommand = mock();
const mockExistsSync = mock();
const mockReadFileSync = mock();
const mockRm = mock();
const mockDetectDirectoryType = mock();

// Set up module mocks
mock.module('@elizaos/core', () => ({
  logger: mockLogger,
}));

mock.module('execa', () => ({
  execa: mockExeca,
}));

mock.module('../../../src/utils/run-bun', () => ({
  runBunCommand: mockRunBunCommand,
}));

mock.module('node:fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  promises: {
    rm: mockRm,
  },
}));

mock.module('../../../src/utils/directory-detection', () => ({
  detectDirectoryType: mockDetectDirectoryType,
}));

describe('buildProject', () => {
  const testProjectPath = '/test/project';
  const testPluginPath = '/test/plugin';

  beforeEach(() => {
    // Clear all mocks
    mockLogger.info.mockClear();
    mockLogger.success.mockClear();
    mockLogger.error.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.debug.mockClear();
    mockExeca.mockClear();
    mockRunBunCommand.mockClear();
    mockExistsSync.mockClear();
    mockReadFileSync.mockClear();
    mockRm.mockClear();
    mockDetectDirectoryType.mockClear();

    // Set up default successful mocks
    mockExistsSync.mockReturnValue(true);
    mockDetectDirectoryType.mockReturnValue({
      type: 'elizaos-project',
      hasPackageJson: true,
      hasElizaOSDependencies: true,
      elizaPackageCount: 1,
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({
      name: 'test-project',
      scripts: {
        build: 'bun run build'
      }
    }));
    mockRunBunCommand.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Clean up any environment state
  });

  it('should log correct messages and call runBunCommand for project build', async () => {
    await buildProject(testProjectPath);

    // Verify logger calls
    expect(mockLogger.info).toHaveBeenCalledWith(`Building project in ${testProjectPath}...`);
    expect(mockLogger.info).toHaveBeenCalledWith('Build completed successfully');
    
    // Verify runBunCommand was called with correct parameters
    expect(mockRunBunCommand).toHaveBeenCalledWith(['run', 'build'], testProjectPath);
  });

  it('should log correct messages and call runBunCommand for plugin build', async () => {
    await buildProject(testPluginPath, true);

    // Verify plugin-specific logging
    expect(mockLogger.info).toHaveBeenCalledWith(`Building plugin in ${testPluginPath}...`);
    expect(mockLogger.info).toHaveBeenCalledWith('Build completed successfully');
    
    // Verify runBunCommand was called for plugin
    expect(mockRunBunCommand).toHaveBeenCalledWith(['run', 'build'], testPluginPath);
  });

  it('should clean dist directory before building', async () => {
    // Mock dist directory exists
    mockExistsSync.mockImplementation((path) => {
      return String(path).includes('dist') || !String(path).includes('tsconfig.json');
    });

    await buildProject(testProjectPath);

    // Verify dist cleanup was attempted
    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining('dist'),
      { recursive: true, force: true }
    );
  });

  it('should fallback to tsc when no build script exists', async () => {
    // Mock package.json without build script
    mockReadFileSync.mockReturnValue(JSON.stringify({
      name: 'test-project'
      // No scripts
    }));
    
    // Mock tsconfig.json exists
    mockExistsSync.mockImplementation((path) => {
      const pathStr = String(path);
      if (pathStr.includes('tsconfig.json')) return true;
      return !pathStr.includes('dist');
    });
    
    mockExeca.mockResolvedValue({ exitCode: 0 });

    await buildProject(testProjectPath);

    // Verify fallback to tsc
    expect(mockExeca).toHaveBeenCalledWith(
      'bunx',
      ['tsc', '--build'],
      expect.objectContaining({
        cwd: testProjectPath,
        stdio: 'inherit'
      })
    );
  });

  it('should throw error when directory does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(buildProject(testProjectPath)).rejects.toThrow(
      `Project directory ${testProjectPath} does not exist.`
    );
  });

  it('should throw error when package.json does not exist', async () => {
    mockDetectDirectoryType.mockReturnValue({
      type: 'elizaos-project',
      hasPackageJson: false,
      hasElizaOSDependencies: true,
      elizaPackageCount: 1,
    });

    await expect(buildProject(testProjectPath)).rejects.toThrow(
      `Project directory ${testProjectPath} does not have package.json.`
    );
  });

  it('should handle build errors and log them correctly', async () => {
    const buildError = new Error('Build failed');
    mockRunBunCommand.mockRejectedValue(buildError);

    await expect(buildProject(testProjectPath)).rejects.toThrow(
      'Failed to build using bun: Error: Build failed'
    );

    // Verify error logging
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to build project: Error: Failed to build using bun: Error: Build failed'
    );
  });

  it('should throw error when no build method can be determined', async () => {
    // Mock package.json without build script
    mockReadFileSync.mockReturnValue(JSON.stringify({
      name: 'test-project'
    }));
    
    // Mock no tsconfig.json
    mockExistsSync.mockImplementation((path) => {
      const pathStr = String(path);
      return !pathStr.includes('tsconfig.json') && !pathStr.includes('dist');
    });

    await expect(buildProject(testProjectPath)).rejects.toThrow(
      'Could not determine how to build the project'
    );
  });

  it('should warn when no build script is found', async () => {
    // Mock package.json without build script
    mockReadFileSync.mockReturnValue(JSON.stringify({
      name: 'test-project'
    }));
    
    // Mock tsconfig.json exists for fallback
    mockExistsSync.mockImplementation((path) => {
      const pathStr = String(path);
      if (pathStr.includes('tsconfig.json')) return true;
      return !pathStr.includes('dist');
    });
    
    mockExeca.mockResolvedValue({ exitCode: 0 });

    await buildProject(testProjectPath);

    // Verify warning was logged
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No build script found')
    );
  });
});