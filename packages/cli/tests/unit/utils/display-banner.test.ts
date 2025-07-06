import { describe, expect, it, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import * as displayBanner from '../../../src/utils/display-banner';
import { UserEnvironment } from '../../../src/utils/user-environment';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('display-banner utils', () => {
  let originalGetInstance: typeof UserEnvironment.getInstance;
  let mockFindMonorepoRoot: ReturnType<typeof mock>;
  let fsExistsSyncSpy: any;
  let fsReadFileSyncSpy: any;
  let isRunningFromNodeModulesSpy: any;

  beforeEach(() => {
    // Save original methods
    originalGetInstance = UserEnvironment.getInstance;

    // Create mocks
    mockFindMonorepoRoot = mock(() => null);

    // Override UserEnvironment.getInstance
    UserEnvironment.getInstance = () =>
      ({
        findMonorepoRoot: mockFindMonorepoRoot,
      }) as any;
  });

  afterEach(() => {
    // Restore original methods
    UserEnvironment.getInstance = originalGetInstance;
    // Bun's spyOn automatically restores after test
  });

  describe('getVersion', () => {
    it('should return "monorepo" when in monorepo context', () => {
      // Mock monorepo detection
      mockFindMonorepoRoot.mockReturnValue('/path/to/monorepo');

      const version = displayBanner.getVersion();

      expect(version).toBe('monorepo');
      expect(mockFindMonorepoRoot).toHaveBeenCalledWith(process.cwd());
    });

    it('should return "monorepo" when not running from node_modules', () => {
      // Mock no monorepo
      mockFindMonorepoRoot.mockReturnValue(null);

      // Mock isRunningFromNodeModules to return false
      isRunningFromNodeModulesSpy = spyOn(
        displayBanner,
        'isRunningFromNodeModules'
      ).mockReturnValue(false);

      const version = displayBanner.getVersion();

      expect(version).toBe('monorepo');
      expect(mockFindMonorepoRoot).toHaveBeenCalledWith(process.cwd());
    });

    it('should return package version when running from node_modules', () => {
      // Mock no monorepo
      mockFindMonorepoRoot.mockReturnValue(null);

      // Mock isRunningFromNodeModules to return true
      isRunningFromNodeModulesSpy = spyOn(
        displayBanner,
        'isRunningFromNodeModules'
      ).mockReturnValue(true);

      // Mock fs methods
      fsExistsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
      fsReadFileSyncSpy = spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({
          version: '1.2.3',
        })
      );

      const version = displayBanner.getVersion();

      expect(version).not.toBe('monorepo');
      expect(version).toContain('1.');
      expect(mockFindMonorepoRoot).toHaveBeenCalledWith(process.cwd());
    });

    it('should return fallback version when package.json is not found', () => {
      // Mock no monorepo
      mockFindMonorepoRoot.mockReturnValue(null);

      // Mock isRunningFromNodeModules to return true
      isRunningFromNodeModulesSpy = spyOn(
        displayBanner,
        'isRunningFromNodeModules'
      ).mockReturnValue(true);

      // Mock fs.existsSync to return false
      fsExistsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);

      // Capture console.error to avoid test output noise
      const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

      const version = displayBanner.getVersion();

      expect(version).toBe('0.0.0');
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should handle JSON parse errors gracefully', () => {
      // Mock no monorepo
      mockFindMonorepoRoot.mockReturnValue(null);

      // Mock isRunningFromNodeModules to return true
      isRunningFromNodeModulesSpy = spyOn(
        displayBanner,
        'isRunningFromNodeModules'
      ).mockReturnValue(true);

      // Mock fs methods
      fsExistsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
      fsReadFileSyncSpy = spyOn(fs, 'readFileSync').mockReturnValue('invalid json');

      // Capture console.error to avoid test output noise
      const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

      const version = displayBanner.getVersion();

      expect(version).toBe('0.0.0');
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('getLatestCliVersion', () => {
    it('should skip version check for monorepo version', async () => {
      const result = await displayBanner.getLatestCliVersion('monorepo');

      expect(result).toBeNull();
    });

    // Skip the execa-dependent tests as they require complex mocking
    // These are better tested in integration tests
  });

  describe('checkAndShowUpdateNotification', () => {
    it('should skip update check for monorepo version', async () => {
      const result = await displayBanner.checkAndShowUpdateNotification('monorepo');

      expect(result).toBe(false);
    });

    // Skip the execa-dependent tests as they require complex mocking
    // These are better tested in integration tests
  });
});
