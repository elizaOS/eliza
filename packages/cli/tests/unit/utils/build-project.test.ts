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

const mockBunExec = mock();
const mockRunBunWithSpinner = mock();
const mockExistsSync = mock();
const mockReadFileSync = mock();
const mockRm = mock();
const mockDetectDirectoryType = mock();

// Set up module mocks
mock.module('@elizaos/core', () => ({
  logger: mockLogger,
}));

mock.module('../../../src/utils/bun-exec', () => ({
  bunExec: mockBunExec,
}));

mock.module('../../../src/utils/spinner-utils', () => ({
  runBunWithSpinner: mockRunBunWithSpinner,
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
    mockBunExec.mockClear();
    mockRunBunWithSpinner.mockClear();
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
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        name: 'test-project',
        scripts: {
          build: 'bun run build',
        },
      })
    );
    mockRunBunWithSpinner.mockResolvedValue({ success: true });
    mockRm.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Clean up any environment state
  });

  it('should log correct messages and call runBunWithSpinner for project build', async () => {
    await buildProject(testProjectPath);

    // Verify runBunWithSpinner was called with correct parameters
    expect(mockRunBunWithSpinner).toHaveBeenCalledWith(
      ['run', 'build'],
      testProjectPath,
      expect.objectContaining({
        spinnerText: 'Building project...',
        successText: expect.stringContaining('Project built successfully'),
        errorText: 'Failed to build project',
      })
    );
  });

  it('should log correct messages and call runBunWithSpinner for plugin build', async () => {
    await buildProject(testPluginPath, true);

    // Verify plugin-specific call
    expect(mockRunBunWithSpinner).toHaveBeenCalledWith(
      ['run', 'build'],
      testPluginPath,
      expect.objectContaining({
        spinnerText: 'Building plugin...',
        successText: expect.stringContaining('Plugin built successfully'),
        errorText: 'Failed to build plugin',
      })
    );
  });

  it('should clean dist directory before building', async () => {
    // Mock dist directory exists
    mockExistsSync.mockImplementation((path) => {
      return String(path).includes('dist') || !String(path).includes('tsconfig.json');
    });

    await buildProject(testProjectPath);

    // Verify dist cleanup was attempted
    expect(mockRm).toHaveBeenCalledWith(expect.stringContaining('dist'), {
      recursive: true,
      force: true,
    });
  });

  it('should fallback to tsc when no build script exists', async () => {
    // Mock package.json without build script
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        name: 'test-project',
        // No scripts
      })
    );

    // Mock tsconfig.json exists
    mockExistsSync.mockImplementation((path) => {
      const pathStr = String(path);
      if (pathStr.includes('tsconfig.json')) return true;
      return !pathStr.includes('dist');
    });

    mockBunExec.mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0 });

    await buildProject(testProjectPath);

    // Verify fallback to tsc
    expect(mockBunExec).toHaveBeenCalledWith(
      'bunx',
      ['tsc', '--build'],
      expect.objectContaining({
        cwd: testProjectPath,
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
    mockRunBunWithSpinner.mockResolvedValue({ success: false, error: buildError });

    await expect(buildProject(testProjectPath)).rejects.toThrow('Build failed');
  });

  it('should throw error when no build method can be determined', async () => {
    // Mock package.json without build script
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        name: 'test-project',
      })
    );

    // Mock no tsconfig.json
    mockExistsSync.mockImplementation((path) => {
      const pathStr = String(path);
      return !pathStr.includes('tsconfig.json') && !pathStr.includes('dist');
    });

    await expect(buildProject(testProjectPath)).rejects.toThrow(
      'Could not determine how to build the project'
    );
  });

  it('should handle tsc build failure', async () => {
    // Mock package.json without build script
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        name: 'test-project',
      })
    );

    // Mock tsconfig.json exists for fallback
    mockExistsSync.mockImplementation((path) => {
      const pathStr = String(path);
      if (pathStr.includes('tsconfig.json')) return true;
      return !pathStr.includes('dist');
    });

    mockBunExec.mockResolvedValue({ success: false, stdout: '', stderr: 'tsc error', exitCode: 1 });

    await expect(buildProject(testProjectPath)).rejects.toThrow('bunx tsc build failed: tsc error');
  });
});
