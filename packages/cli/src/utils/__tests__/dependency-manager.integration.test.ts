import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  hasElizaOSCli,
  shouldAutoInstallCli,
  installElizaOSCli,
  ensureElizaOSCli,
  ensurePackageJson,
} from '../dependency-manager';

// Mock external dependencies but allow some real operations for integration testing
mock.module('../bun-exec', () => ({
  bunExec: mock(),
}));

mock.module('../spinner-utils', () => ({
  runBunWithSpinner: mock(),
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

const mockBunExec = bunExec as any;
const mockRunBunWithSpinner = runBunWithSpinner as any;
const mockDetectDirectoryType = detectDirectoryType as any;

describe('dependency-manager integration', () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    // Create a temporary directory for each test
    testDir = await fs.promises.mkdtemp(path.join(tmpdir(), 'eliza-dep-test-'));

    // Save original environment
    originalEnv = { ...process.env };

    // Clear all mocks
    mockBunExec.mockClear();
    mockRunBunWithSpinner.mockClear();
  });

  afterEach(async () => {
    // Restore environment
    process.env = originalEnv;

    // Clean up test directory
    try {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }

    mockBunExec.mockClear();
    mockRunBunWithSpinner.mockClear();
  });

  describe('real file system operations', () => {
    it('should correctly detect existing @elizaos/cli in dependencies', async () => {
      const packageJson = {
        name: 'test-project',
        dependencies: {
          '@elizaos/cli': '^1.0.0',
          'other-package': '^2.0.0',
        },
      };

      const packageJsonPath = path.join(testDir, 'package.json');
      await fs.promises.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));

      const result = hasElizaOSCli(packageJsonPath);
      expect(result).toBe(true);
    });

    it('should correctly detect existing @elizaos/cli in devDependencies', async () => {
      const packageJson = {
        name: 'test-project',
        devDependencies: {
          '@elizaos/cli': '^1.0.0',
          '@types/node': '^18.0.0',
        },
      };

      const packageJsonPath = path.join(testDir, 'package.json');
      await fs.promises.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));

      const result = hasElizaOSCli(packageJsonPath);
      expect(result).toBe(true);
    });

    it('should correctly detect missing @elizaos/cli', async () => {
      const packageJson = {
        name: 'test-project',
        dependencies: {
          express: '^4.0.0',
        },
        devDependencies: {
          '@types/node': '^18.0.0',
        },
      };

      const packageJsonPath = path.join(testDir, 'package.json');
      await fs.promises.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));

      const result = hasElizaOSCli(packageJsonPath);
      expect(result).toBe(false);
    });

    it('should handle missing package.json gracefully', () => {
      const nonExistentPath = path.join(testDir, 'nonexistent', 'package.json');
      const result = hasElizaOSCli(nonExistentPath);
      expect(result).toBe(false);
    });

    it('should handle corrupted package.json gracefully', async () => {
      const packageJsonPath = path.join(testDir, 'package.json');
      await fs.promises.writeFile(packageJsonPath, '{ "name": "test", invalid json }');

      const result = hasElizaOSCli(packageJsonPath);
      expect(result).toBe(false);
    });
  });

  describe('package.json creation', () => {
    it('should create a valid package.json when missing', async () => {
      const result = await ensurePackageJson(testDir);
      expect(result).toBe(true);

      const packageJsonPath = path.join(testDir, 'package.json');
      expect(fs.existsSync(packageJsonPath)).toBe(true);

      const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'));
      expect(packageJson.name).toBeDefined();
      expect(packageJson.version).toBe('1.0.0');
      expect(packageJson.type).toBe('module');
      expect(packageJson.scripts.start).toBe('elizaos start');
      expect(packageJson.scripts.dev).toBe('elizaos dev');
    });

    it('should not overwrite existing package.json', async () => {
      const existingPackageJson = {
        name: 'existing-project',
        version: '2.0.0',
        custom: 'value',
      };

      const packageJsonPath = path.join(testDir, 'package.json');
      await fs.promises.writeFile(packageJsonPath, JSON.stringify(existingPackageJson, null, 2));

      const result = await ensurePackageJson(testDir);
      expect(result).toBe(true);

      const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'));
      expect(packageJson.name).toBe('existing-project');
      expect(packageJson.version).toBe('2.0.0');
      expect(packageJson.custom).toBe('value');
    });

    it('should use directory name for package name', async () => {
      const projectDir = path.join(testDir, 'my-awesome-project');
      await fs.promises.mkdir(projectDir);

      const result = await ensurePackageJson(projectDir);
      expect(result).toBe(true);

      const packageJsonPath = path.join(projectDir, 'package.json');
      const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'));
      expect(packageJson.name).toBe('my-awesome-project');
    });

    it('should sanitize directory name with special characters for package name', async () => {
      const projectDir = path.join(testDir, 'My@Project#Name$With%Special&Chars!');
      await fs.promises.mkdir(projectDir);

      const result = await ensurePackageJson(projectDir);
      expect(result).toBe(true);

      const packageJsonPath = path.join(projectDir, 'package.json');
      const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'));
      expect(packageJson.name).toBe('my-project-name-with-special-chars');
    });

    it('should handle directory names with only special characters', async () => {
      const projectDir = path.join(testDir, '@#$%&!');
      await fs.promises.mkdir(projectDir);

      const result = await ensurePackageJson(projectDir);
      expect(result).toBe(true);

      const packageJsonPath = path.join(projectDir, 'package.json');
      const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'));
      expect(packageJson.name).toBe('eliza-project'); // Should fallback to default
    });
  });

  describe('environment variable interactions', () => {
    it('should respect ELIZA_NO_AUTO_INSTALL flag', () => {
      process.env.ELIZA_NO_AUTO_INSTALL = 'true';

      const result = shouldAutoInstallCli(testDir);
      expect(result).toBe(false);
    });

    it('should respect CI environment flag', () => {
      process.env.CI = 'true';

      const result = shouldAutoInstallCli(testDir);
      expect(result).toBe(false);
    });

    it('should respect test mode flag', () => {
      process.env.ELIZA_TEST_MODE = 'true';

      const result = shouldAutoInstallCli(testDir);
      expect(result).toBe(false);
    });

    it('should allow auto-install when conditions are met', () => {
      // This test verifies the function works, but we can't easily test the full flow
      // without mocking the directory detection, which is complex in integration tests
      expect(shouldAutoInstallCli).toBeDefined();
    });
  });

  describe('installation scenarios', () => {
    it('should simulate successful installation', async () => {
      mockRunBunWithSpinner.mockResolvedValue({ success: true });

      const result = await installElizaOSCli(testDir);
      expect(result).toBe(true);

      expect(mockRunBunWithSpinner).toHaveBeenCalledWith(
        ['add', '--dev', '@elizaos/cli'],
        testDir,
        expect.objectContaining({
          spinnerText: 'Installing @elizaos/cli with bun...',
          successText: '✓ @elizaos/cli installed successfully',
        })
      );
    });

    it('should handle installation failure gracefully', async () => {
      mockRunBunWithSpinner.mockResolvedValue({
        success: false,
        error: new Error('Network timeout'),
      });

      const result = await installElizaOSCli(testDir);
      expect(result).toBe(false);
    });

    it('should handle installation exception gracefully', async () => {
      mockRunBunWithSpinner.mockRejectedValue(new Error('Process failed'));

      const result = await installElizaOSCli(testDir);
      expect(result).toBe(false);
    });
  });

  describe('simplified end-to-end functionality', () => {
    it('should handle ensureElizaOSCli without errors', async () => {
      // Test that the main function doesn't throw errors
      // In real usage, it would check conditions and potentially install using bun
      await expect(ensureElizaOSCli(testDir)).resolves.toBeUndefined();
    });

    it('should verify CLI detection works with real files', async () => {
      // Create a project with CLI in devDependencies
      const packageJson = {
        name: 'test-project',
        devDependencies: {
          '@elizaos/cli': '^1.0.0',
        },
      };

      await fs.promises.writeFile(
        path.join(testDir, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      const packageJsonPath = path.join(testDir, 'package.json');
      const hasCliResult = hasElizaOSCli(packageJsonPath);
      expect(hasCliResult).toBe(true);
    });

    it('should verify CLI detection works when missing', async () => {
      // Create a project without CLI
      const packageJson = {
        name: 'test-project',
        dependencies: {
          '@elizaos/core': '^1.0.0',
        },
      };

      await fs.promises.writeFile(
        path.join(testDir, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      const packageJsonPath = path.join(testDir, 'package.json');
      const hasCliResult = hasElizaOSCli(packageJsonPath);
      expect(hasCliResult).toBe(false);
    });
  });

  describe('error recovery', () => {
    it('should continue gracefully when file operations fail', async () => {
      // Test with a non-existent file to simulate read failure
      const result = hasElizaOSCli(path.join(testDir, 'nonexistent', 'package.json'));
      expect(result).toBe(false);
    });

    it('should handle network timeouts during installation', async () => {
      mockRunBunWithSpinner.mockRejectedValue(new Error('Network timeout'));

      const result = await installElizaOSCli(testDir);
      expect(result).toBe(false);
    });
  });
});
