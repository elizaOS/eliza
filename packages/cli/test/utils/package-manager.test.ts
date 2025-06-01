import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 1. Hoisted Mocks
const { mockLogger, mockExeca, mockUserEnvironmentGetInstanceInfo } = vi.hoisted(() => {
  return {
    mockLogger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
    mockExeca: vi.fn(),
    mockUserEnvironmentGetInstanceInfo: vi.fn(),
  };
});

// 2. Apply Mocks BEFORE importing SUT
vi.mock('execa', () => ({ execa: mockExeca }));
vi.mock('@elizaos/core', () => ({ logger: mockLogger }));
vi.mock('../../src/utils/user-environment', () => ({
  UserEnvironment: {
    getInstanceInfo: mockUserEnvironmentGetInstanceInfo,
  },
}));

// 3. Import SUT AFTER mocks
import {
  getPackageManager,
  isGlobalInstallation,
  isRunningViaNpx,
  isRunningViaBunx,
  getInstallCommand,
  executeInstallation,
} from '../../src/utils/package-manager';

describe('package-manager', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'package-manager-test-'));
    vi.clearAllMocks();

    // Set default mock behavior
    mockUserEnvironmentGetInstanceInfo.mockResolvedValue({
      packageManager: {
        name: 'npm',
        version: 'latest',
        global: false,
        isNpx: false,
        isBunx: false,
      },
    });
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('getPackageManager', () => {
    it('should return the detected package manager when known', async () => {
      mockUserEnvironmentGetInstanceInfo.mockResolvedValue({
        packageManager: { name: 'npm' },
      });
      const result = await getPackageManager();
      expect(result).toBe('npm');
      expect(mockLogger.debug).toHaveBeenCalledWith('[PackageManager] Detecting package manager');
    });

    it('should return bun as default when package manager is unknown', async () => {
      mockUserEnvironmentGetInstanceInfo.mockResolvedValue({
        packageManager: { name: 'unknown' },
      });
      const result = await getPackageManager();
      expect(result).toBe('bun');
      expect(mockLogger.debug).toHaveBeenCalledWith('[PackageManager] Detecting package manager');
    });

    it('should handle different package managers', async () => {
      const packageManagers = ['npm', 'yarn', 'pnpm', 'bun'];
      for (const pm of packageManagers) {
        mockUserEnvironmentGetInstanceInfo.mockResolvedValue({
          packageManager: { name: pm },
        });
        const result = await getPackageManager();
        expect(result).toBe(pm);
      }
    });
  });

  describe('isGlobalInstallation', () => {
    it('should return true when CLI is globally installed', async () => {
      mockUserEnvironmentGetInstanceInfo.mockResolvedValue({
        packageManager: { global: true },
      });

      const result = await isGlobalInstallation();

      expect(result).toBe(true);
    });

    it('should return false when CLI is not globally installed', async () => {
      mockUserEnvironmentGetInstanceInfo.mockResolvedValue({
        packageManager: { global: false },
      });

      const result = await isGlobalInstallation();

      expect(result).toBe(false);
    });
  });

  describe('isRunningViaNpx', () => {
    it('should return true when running via npx', async () => {
      mockUserEnvironmentGetInstanceInfo.mockResolvedValue({
        packageManager: { isNpx: true },
      });

      const result = await isRunningViaNpx();

      expect(result).toBe(true);
    });

    it('should return false when not running via npx', async () => {
      mockUserEnvironmentGetInstanceInfo.mockResolvedValue({
        packageManager: { isNpx: false },
      });

      const result = await isRunningViaNpx();

      expect(result).toBe(false);
    });
  });

  describe('isRunningViaBunx', () => {
    it('should return true when running via bunx', async () => {
      mockUserEnvironmentGetInstanceInfo.mockResolvedValue({
        packageManager: { isBunx: true },
      });

      const result = await isRunningViaBunx();

      expect(result).toBe(true);
    });

    it('should return false when not running via bunx', async () => {
      mockUserEnvironmentGetInstanceInfo.mockResolvedValue({
        packageManager: { isBunx: false },
      });

      const result = await isRunningViaBunx();

      expect(result).toBe(false);
    });
  });

  describe('getInstallCommand', () => {
    it('should return npm install command for local installation', () => {
      const result = getInstallCommand('npm', false);

      expect(result).toEqual(['install']);
    });

    it('should return npm install command for global installation', () => {
      const result = getInstallCommand('npm', true);

      expect(result).toEqual(['install', '-g']);
    });

    it('should return bun add command for local installation', () => {
      const result = getInstallCommand('bun', false);

      expect(result).toEqual(['add']);
    });

    it('should return bun add command for global installation', () => {
      const result = getInstallCommand('bun', true);

      expect(result).toEqual(['add', '-g']);
    });

    it('should default to bun commands for unknown package managers', () => {
      const result = getInstallCommand('yarn', false);

      expect(result).toEqual(['add']);
    });
  });

  describe('executeInstallation', () => {
    beforeEach(() => {
      mockUserEnvironmentGetInstanceInfo.mockResolvedValue({
        packageManager: { name: 'npm' },
      });
    });

    it('should successfully install a regular package', async () => {
      const packageName = 'example-package';
      mockExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      const result = await executeInstallation(packageName, undefined, tempDir);

      expect(mockExeca).toHaveBeenCalledWith(
        'npm',
        ['install', packageName],
        expect.objectContaining({ cwd: tempDir, stdio: 'inherit' })
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        `Attempting to install package: ${packageName} using npm`
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(`Successfully installed ${packageName}.`);
      expect(result).toEqual({ success: true, installedIdentifier: packageName });
    });

    it('should install package with version', async () => {
      mockExeca.mockResolvedValue({});

      const result = await executeInstallation('lodash', '4.17.21');

      expect(mockExeca).toHaveBeenCalledWith('npm', ['install', 'lodash@4.17.21'], {
        cwd: process.cwd(),
        stdio: 'inherit',
      });
      expect(result).toEqual({
        success: true,
        installedIdentifier: 'lodash',
      });
    });

    it('should install package in specified directory', async () => {
      mockExeca.mockResolvedValue({});
      const customDir = '/test/resources/directory';

      await executeInstallation('lodash', '', customDir);

      expect(mockExeca).toHaveBeenCalledWith('npm', ['install', 'lodash'], {
        cwd: customDir,
        stdio: 'inherit',
      });
    });

    it('should handle GitHub packages without version', async () => {
      mockExeca.mockResolvedValue({});

      const result = await executeInstallation('github:owner/repo');

      expect(mockExeca).toHaveBeenCalledWith('npm', ['install', 'github:owner/repo'], {
        cwd: process.cwd(),
        stdio: 'inherit',
      });
      expect(result).toEqual({
        success: true,
        installedIdentifier: '@owner/repo',
      });
    });

    it('should handle GitHub packages with version/tag', async () => {
      mockExeca.mockResolvedValue({});

      const result = await executeInstallation('github:owner/repo', 'v1.0.0');

      expect(mockExeca).toHaveBeenCalledWith('npm', ['install', 'github:owner/repo#v1.0.0'], {
        cwd: process.cwd(),
        stdio: 'inherit',
      });
      expect(result).toEqual({
        success: true,
        installedIdentifier: '@owner/repo',
      });
    });

    it('should handle GitHub packages with complex repo names', async () => {
      mockExeca.mockResolvedValue({});

      const result = await executeInstallation('github:owner/repo-name-with-dashes');

      expect(result).toEqual({
        success: true,
        installedIdentifier: '@owner/repo-name-with-dashes',
      });
    });

    it('should handle installation failure', async () => {
      const error = new Error('Installation failed');
      mockExeca.mockRejectedValue(error);

      const result = await executeInstallation('nonexistent-package');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Installation failed for nonexistent-package: Installation failed'
      );
      expect(result).toEqual({
        success: false,
        installedIdentifier: null,
      });
    });

    it('should use bun when detected as package manager', async () => {
      const packageName = 'example-package';
      mockUserEnvironmentGetInstanceInfo.mockResolvedValue({
        packageManager: { name: 'bun' },
      });
      mockExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      const result = await executeInstallation(packageName, undefined, tempDir);

      expect(mockExeca).toHaveBeenCalledWith(
        'bun',
        ['add', packageName],
        expect.objectContaining({ cwd: tempDir, stdio: 'inherit' })
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        `Attempting to install package: ${packageName} using bun`
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(`Successfully installed ${packageName}.`);
      expect(result).toEqual({ success: true, installedIdentifier: packageName });
    });

    it('should handle scoped packages', async () => {
      mockExeca.mockResolvedValue({});

      const result = await executeInstallation('@scope/package', '1.0.0');

      expect(mockExeca).toHaveBeenCalledWith('npm', ['install', '@scope/package@1.0.0'], {
        cwd: process.cwd(),
        stdio: 'inherit',
      });
      expect(result).toEqual({
        success: true,
        installedIdentifier: '@scope/package',
      });
    });

    it('should handle GitHub packages with existing hash in name', async () => {
      mockExeca.mockResolvedValue({});

      const result = await executeInstallation('github:owner/repo#existing-ref', 'new-ref');

      expect(mockExeca).toHaveBeenCalledWith(
        'npm',
        ['install', 'github:owner/repo#existing-ref#new-ref'],
        {
          cwd: process.cwd(),
          stdio: 'inherit',
        }
      );
      expect(result).toEqual({
        success: true,
        installedIdentifier: '@owner/repo',
      });
    });
  });
});
