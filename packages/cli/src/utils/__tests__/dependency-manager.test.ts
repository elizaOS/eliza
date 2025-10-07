import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  hasElizaOSCli,
  shouldAutoInstallCli,
  installElizaOSCli,
  ensureElizaOSCli,
  getLatestElizaOSCliVersion,
  hasElizaOSDependencies,
  ensurePackageJson,
} from '../dependency-manager';

// Mock external dependencies
mock.module('node:fs', () => ({
  existsSync: mock(),
  readFileSync: mock(),
  writeFileSync: mock(),
}));

mock.module('../bun-exec', () => ({
  bunExec: mock(),
}));

mock.module('../spinner-utils', () => ({
  runBunWithSpinner: mock(),
}));

mock.module('../directory-detection', () => ({
  detectDirectoryType: mock(),
}));

mock.module('@elizaos/core', () => ({
  logger: {
    debug: mock(),
    info: mock(),
    warn: mock(),
    error: mock(),
  },
}));

import { bunExec } from '../bun-exec';
import { runBunWithSpinner } from '../spinner-utils';
import { detectDirectoryType } from '../directory-detection';

const mockFs = fs as any;
const mockBunExec = bunExec as any;
const mockRunBunWithSpinner = runBunWithSpinner as any;
const mockDetectDirectoryType = detectDirectoryType as any;

describe('dependency-manager', () => {
  beforeEach(() => {
    // Clear all mocks
    mockFs.existsSync.mockClear();
    mockFs.readFileSync.mockClear();
    mockFs.writeFileSync.mockClear();
    mockBunExec.mockClear();
    mockRunBunWithSpinner.mockClear();
    mockDetectDirectoryType.mockClear();

    // Reset environment variables
    delete process.env.ELIZA_NO_AUTO_INSTALL;
    delete process.env.CI;
    delete process.env.ELIZA_TEST_MODE;
  });

  afterEach(() => {
    mockFs.existsSync.mockClear();
    mockFs.readFileSync.mockClear();
    mockFs.writeFileSync.mockClear();
    mockBunExec.mockClear();
    mockRunBunWithSpinner.mockClear();
    mockDetectDirectoryType.mockClear();
  });

  describe('hasElizaOSCli', () => {
    it('should return false if package.json does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = hasElizaOSCli('/fake/path/package.json');

      expect(result).toBe(false);
      expect(mockFs.existsSync).toHaveBeenCalledWith('/fake/path/package.json');
    });

    it('should return true if @elizaos/cli is in dependencies', () => {
      const packageJson = {
        dependencies: {
          '@elizaos/cli': '^1.0.0',
        },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(packageJson));

      const result = hasElizaOSCli('/fake/path/package.json');

      expect(result).toBe(true);
    });

    it('should return true if @elizaos/cli is in devDependencies', () => {
      const packageJson = {
        devDependencies: {
          '@elizaos/cli': '^1.0.0',
        },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(packageJson));

      const result = hasElizaOSCli('/fake/path/package.json');

      expect(result).toBe(true);
    });

    it('should return false if @elizaos/cli is not present', () => {
      const packageJson = {
        dependencies: {
          'other-package': '^1.0.0',
        },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(packageJson));

      const result = hasElizaOSCli('/fake/path/package.json');

      expect(result).toBe(false);
    });

    it('should handle malformed JSON gracefully', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('{ "name": "test", invalid json }');

      const result = hasElizaOSCli('/fake/path/package.json');

      expect(result).toBe(false);
    });

    it('should handle JSON parsing errors with detailed logging', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('{"incomplete": json');

      const result = hasElizaOSCli('/fake/path/package.json');

      expect(result).toBe(false);
    });
  });

  describe('shouldAutoInstallCli', () => {
    it('should return false if auto-install is disabled', () => {
      process.env.ELIZA_NO_AUTO_INSTALL = 'true';

      const result = shouldAutoInstallCli();

      expect(result).toBe(false);
    });

    it('should return false in CI environment', () => {
      process.env.CI = 'true';

      const result = shouldAutoInstallCli();

      expect(result).toBe(false);
    });

    it('should return false in test environment', () => {
      process.env.ELIZA_TEST_MODE = 'true';

      const result = shouldAutoInstallCli();

      expect(result).toBe(false);
    });

    it('should return false in monorepo', () => {
      mockDetectDirectoryType.mockReturnValue({
        type: 'elizaos-monorepo',
        hasPackageJson: true,
      });

      const result = shouldAutoInstallCli();

      expect(result).toBe(false);
    });

    it('should return false if in monorepo subdirectory', () => {
      mockDetectDirectoryType.mockReturnValue({
        type: 'elizaos-project',
        hasPackageJson: true,
        monorepoRoot: '/some/monorepo',
      });

      const result = shouldAutoInstallCli();

      expect(result).toBe(false);
    });

    it('should return false if no package.json', () => {
      mockDetectDirectoryType.mockReturnValue({
        type: 'elizaos-project',
        hasPackageJson: false,
      });

      const result = shouldAutoInstallCli();

      expect(result).toBe(false);
    });

    it('should return false if @elizaos/cli already present', () => {
      mockDetectDirectoryType.mockReturnValue({
        type: 'elizaos-project',
        hasPackageJson: true,
      });

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          devDependencies: {
            '@elizaos/cli': '^1.0.0',
          },
        })
      );

      const result = shouldAutoInstallCli('/test/dir');

      expect(result).toBe(false);
    });

    it('should return true for valid project without @elizaos/cli', () => {
      mockDetectDirectoryType.mockReturnValue({
        type: 'elizaos-project',
        hasPackageJson: true,
      });

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          dependencies: {
            'other-package': '^1.0.0',
          },
        })
      );

      const result = shouldAutoInstallCli('/test/dir');

      expect(result).toBe(true);
    });
  });

  describe('installElizaOSCli', () => {
    it('should successfully install @elizaos/cli', async () => {
      mockRunBunWithSpinner.mockResolvedValue({
        success: true,
      });

      const result = await installElizaOSCli('/test/dir');

      expect(result).toBe(true);
      expect(mockRunBunWithSpinner).toHaveBeenCalledWith(
        ['add', '--dev', '@elizaos/cli'],
        '/test/dir',
        expect.objectContaining({
          spinnerText: 'Installing @elizaos/cli with bun...',
          successText: '✓ @elizaos/cli installed successfully',
        })
      );
    });

    it('should handle installation failure gracefully', async () => {
      mockRunBunWithSpinner.mockResolvedValue({
        success: false,
        error: new Error('Installation failed'),
      });

      const result = await installElizaOSCli('/test/dir');

      expect(result).toBe(false);
    });

    it('should handle exceptions gracefully', async () => {
      mockRunBunWithSpinner.mockRejectedValue(new Error('Network error'));

      const result = await installElizaOSCli('/test/dir');

      expect(result).toBe(false);
    });
  });

  describe('ensureElizaOSCli', () => {
    it('should do nothing if conditions are not met', async () => {
      process.env.ELIZA_NO_AUTO_INSTALL = 'true';

      await ensureElizaOSCli();

      expect(mockBunExec).not.toHaveBeenCalled();
      expect(mockRunBunWithSpinner).not.toHaveBeenCalled();
    });

    it('should install CLI if all conditions are met', async () => {
      mockDetectDirectoryType.mockReturnValue({
        type: 'elizaos-project',
        hasPackageJson: true,
      });

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({}));

      mockRunBunWithSpinner.mockResolvedValue({ success: true });

      await ensureElizaOSCli();

      expect(mockRunBunWithSpinner).toHaveBeenCalledWith(
        ['add', '--dev', '@elizaos/cli'],
        expect.any(String),
        expect.any(Object)
      );
    });
  });

  describe('getLatestElizaOSCliVersion', () => {
    it('should return version if available', async () => {
      const mockInfo = {
        version: '1.2.3',
      };

      mockBunExec.mockResolvedValue({
        success: true,
        stdout: JSON.stringify(mockInfo),
      });

      const result = await getLatestElizaOSCliVersion();

      expect(result).toBe('1.2.3');
      expect(mockBunExec).toHaveBeenCalledWith('bun', ['info', '@elizaos/cli', '--json'], {
        stdio: 'pipe',
      });
    });

    it('should return dist.version if version not available', async () => {
      const mockInfo = {
        dist: {
          version: '1.2.4',
        },
      };

      mockBunExec.mockResolvedValue({
        success: true,
        stdout: JSON.stringify(mockInfo),
      });

      const result = await getLatestElizaOSCliVersion();

      expect(result).toBe('1.2.4');
    });

    it('should return null if command fails', async () => {
      mockBunExec.mockResolvedValue({
        success: false,
      });

      const result = await getLatestElizaOSCliVersion();

      expect(result).toBe(null);
    });

    it('should return null if JSON parsing fails', async () => {
      mockBunExec.mockResolvedValue({
        success: true,
        stdout: '{"incomplete": json',
      });

      const result = await getLatestElizaOSCliVersion();

      expect(result).toBe(null);
    });

    it('should handle empty JSON response gracefully', async () => {
      mockBunExec.mockResolvedValue({
        success: true,
        stdout: '{}',
      });

      const result = await getLatestElizaOSCliVersion();

      expect(result).toBe('latest');
    });
  });

  describe('hasElizaOSDependencies', () => {
    it('should return true if directory has ElizaOS dependencies', () => {
      mockDetectDirectoryType.mockReturnValue({
        hasElizaOSDependencies: true,
        elizaPackageCount: 3,
      });

      const result = hasElizaOSDependencies();

      expect(result).toBe(true);
    });

    it('should return false if no ElizaOS dependencies', () => {
      mockDetectDirectoryType.mockReturnValue({
        hasElizaOSDependencies: false,
        elizaPackageCount: 0,
      });

      const result = hasElizaOSDependencies();

      expect(result).toBe(false);
    });

    it('should return false if has dependencies but count is zero', () => {
      mockDetectDirectoryType.mockReturnValue({
        hasElizaOSDependencies: true,
        elizaPackageCount: 0,
      });

      const result = hasElizaOSDependencies();

      expect(result).toBe(false);
    });
  });

  describe('ensurePackageJson', () => {
    it('should return true if package.json already exists', async () => {
      mockFs.existsSync.mockReturnValue(true);

      const result = await ensurePackageJson('/test/dir');

      expect(result).toBe(true);
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should create package.json if it does not exist', async () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.writeFileSync.mockImplementation(() => {});

      const result = await ensurePackageJson('/test/my-project');

      expect(result).toBe(true);
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        '/test/my-project/package.json',
        expect.stringContaining('"name": "my-project"')
      );
    });

    it('should handle write errors gracefully', async () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.writeFileSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const result = await ensurePackageJson('/test/dir');

      expect(result).toBe(false);
    });

    it('should use directory name for package name', async () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.writeFileSync.mockImplementation(() => {});

      await ensurePackageJson('/path/to/my-awesome-project');

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const packageJsonContent = writeCall[1];
      const packageJson = JSON.parse(packageJsonContent);

      expect(packageJson.name).toBe('my-awesome-project');
      expect(packageJson.scripts.start).toBe('elizaos start');
      expect(packageJson.scripts.dev).toBe('elizaos dev');
    });
  });
});
