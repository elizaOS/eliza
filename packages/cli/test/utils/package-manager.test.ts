import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';

// Mock dependencies
vi.mock('@elizaos/core', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('../../src/utils/user-environment', () => ({
  UserEnvironment: {
    getInstanceInfo: vi.fn(),
  },
}));

import {
  getPackageManager,
  isGlobalInstallation,
  isRunningViaNpx,
  isRunningViaBunx,
  getInstallCommand,
  executeInstallation,
} from '../../src/utils/package-manager';
import { logger } from '@elizaos/core';
import { execa } from 'execa';
import { UserEnvironment } from '../../src/utils/user-environment';

describe('package-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // describe('getPackageManager', () => {
  //   it('should return the detected package manager when known', async () => {
  //     (UserEnvironment.getInstanceInfo as Mock).mockResolvedValue({
  //       packageManager: { name: 'bun' },
  //     });

  //     const result = await getPackageManager();

  //     expect(result).toBe('bun');
  //     expect(logger.debug).toHaveBeenCalledWith('[PackageManager] Detecting package manager');
  //   });

  //   it('should return bun as default when package manager is unknown', async () => {
  //     (UserEnvironment.getInstanceInfo as Mock).mockResolvedValue({
  //       packageManager: { name: 'unknown' },
  //     });

  //     const result = await getPackageManager();

  //     expect(result).toBe('bun');
  //   });

  //   // it('should handle different package managers', async () => {
  //   //   const packageManagers = ['yarn', 'pnpm', 'bun'];

  //   //   for (const pm of packageManagers) {
  //   //     (UserEnvironment.getInstanceInfo as Mock).mockResolvedValue({
  //   //       packageManager: { name: pm },
  //   //     });

  //   //     const result = await getPackageManager();
  //   //     expect(result).toBe(pm);
  //   //   }
  //   // });
  // });

  describe('isGlobalInstallation', () => {
    it('should return true when CLI is globally installed', async () => {
      (UserEnvironment.getInstanceInfo as Mock).mockResolvedValue({
        packageManager: { global: true },
      });

      const result = await isGlobalInstallation();

      expect(result).toBe(true);
    });

    it('should return false when CLI is not globally installed', async () => {
      (UserEnvironment.getInstanceInfo as Mock).mockResolvedValue({
        packageManager: { global: false },
      });

      const result = await isGlobalInstallation();

      expect(result).toBe(false);
    });
  });

  describe('isRunningViaNpx', () => {
    it('should return true when running via npx', async () => {
      (UserEnvironment.getInstanceInfo as Mock).mockResolvedValue({
        packageManager: { isNpx: true },
      });

      const result = await isRunningViaNpx();

      expect(result).toBe(true);
    });

    it('should return false when not running via npx', async () => {
      (UserEnvironment.getInstanceInfo as Mock).mockResolvedValue({
        packageManager: { isNpx: false },
      });

      const result = await isRunningViaNpx();

      expect(result).toBe(false);
    });
  });

  describe('isRunningViaBunx', () => {
    it('should return true when running via bunx', async () => {
      (UserEnvironment.getInstanceInfo as Mock).mockResolvedValue({
        packageManager: { isBunx: true },
      });

      const result = await isRunningViaBunx();

      expect(result).toBe(true);
    });

    it('should return false when not running via bunx', async () => {
      (UserEnvironment.getInstanceInfo as Mock).mockResolvedValue({
        packageManager: { isBunx: false },
      });

      const result = await isRunningViaBunx();

      expect(result).toBe(false);
    });
  });

  describe('getInstallCommand', () => {
    it('should return npm install command for local installation', () => {
      const result = getInstallCommand(false);

      expect(result).toEqual(['add']);
    });

    it('should return npm install command for global installation', () => {
      const result = getInstallCommand(true);

      expect(result).toEqual(['add', '-g']);
    });

    it('should return bun add command for local installation', () => {
      const result = getInstallCommand(false);

      expect(result).toEqual(['add']);
    });

    it('should return bun add command for global installation', () => {
      const result = getInstallCommand(true);

      expect(result).toEqual(['add', '-g']);
    });
  });

  // describe('executeInstallation', () => {
  //   const mockExeca = execa as Mock;

  //   beforeEach(() => {
  //     (UserEnvironment.getInstanceInfo as Mock).mockResolvedValue({
  //       packageManager: { name: 'bun' },
  //     });
  //   });

  //   it('should successfully install a regular package', async () => {
  //     mockExeca.mockResolvedValue({});

  //     const result = await executeInstallation('lodash');

  //     expect(mockExeca).toHaveBeenCalledWith(['add', 'lodash'], {
  //       cwd: process.cwd(),
  //       stdio: 'inherit',
  //     });
  //     expect(logger.debug).toHaveBeenCalledWith('Attempting to install package: lodash using npm');
  //     expect(logger.debug).toHaveBeenCalledWith('Successfully installed lodash.');
  //     expect(result).toEqual({
  //       success: true,
  //       installedIdentifier: 'lodash',
  //     });
  //   });

  //   it('should install package with version', async () => {
  //     mockExeca.mockResolvedValue({});

  //     const result = await executeInstallation('lodash', '4.17.21');

  //     expect(mockExeca).toHaveBeenCalledWith(['add', 'lodash@4.17.21'], {
  //       cwd: process.cwd(),
  //       stdio: 'inherit',
  //     });
  //     expect(result).toEqual({
  //       success: true,
  //       installedIdentifier: 'lodash',
  //     });
  //   });

  // it('should install package in specified directory', async () => {
  //   mockExeca.mockResolvedValue({});
  //   const customDir = '/test/resources/directory';

  //   await executeInstallation('lodash', '', customDir);

  //   expect(mockExeca).toHaveBeenCalledWith(['add', 'lodash'], {
  //     cwd: customDir,
  //     stdio: 'inherit',
  //   });
  // });

  // it('should handle GitHub packages without version', async () => {
  //   mockExeca.mockResolvedValue({});

  //   const result = await executeInstallation('github:owner/repo');

  //   expect(mockExeca).toHaveBeenCalledWith(['add', 'github:owner/repo'], {
  //     cwd: process.cwd(),
  //     stdio: 'inherit',
  //   });
  //   expect(result).toEqual({
  //     success: true,
  //     installedIdentifier: '@owner/repo',
  //   });
  // });

  // it('should handle GitHub packages with version/tag', async () => {
  //   mockExeca.mockResolvedValue({});

  //   const result = await executeInstallation('github:owner/repo', 'v1.0.0');

  //   expect(mockExeca).toHaveBeenCalledWith(['add', 'github:owner/repo#v1.0.0'], {
  //     cwd: process.cwd(),
  //     stdio: 'inherit',
  //   });
  //   expect(result).toEqual({
  //     success: true,
  //     installedIdentifier: '@owner/repo',
  //   });
  // });

  // it('should handle GitHub packages with complex repo names', async () => {
  //   mockExeca.mockResolvedValue({});

  //   const result = await executeInstallation('github:owner/repo-name-with-dashes');

  //   expect(result).toEqual({
  //     success: true,
  //     installedIdentifier: '@owner/repo-name-with-dashes',
  //   });
  // });

  // it('should handle installation failure', async () => {
  //   const error = new Error('Installation failed');
  //   mockExeca.mockRejectedValue(error);

  //   const result = await executeInstallation('nonexistent-package');

  //   expect(logger.warn).toHaveBeenCalledWith(
  //     'Installation failed for nonexistent-package: Installation failed'
  //   );
  //   expect(result).toEqual({
  //     success: false,
  //     installedIdentifier: null,
  //   });
  // });

  // it('should use bun when detected as package manager', async () => {
  //   (UserEnvironment.getInstanceInfo as Mock).mockResolvedValue({
  //     packageManager: { name: 'bun' },
  //   });
  //   mockExeca.mockResolvedValue({});

  //   await executeInstallation('lodash');

  //   expect(mockExeca).toHaveBeenCalledWith(['add', 'lodash'], {
  //     cwd: process.cwd(),
  //     stdio: 'inherit',
  //   });
  //   expect(logger.debug).toHaveBeenCalledWith('Attempting to install package: lodash using bun');
  // });

  // it('should handle scoped packages', async () => {
  //   mockExeca.mockResolvedValue({});

  //   const result = await executeInstallation('@scope/package', '1.0.0');

  //   expect(mockExeca).toHaveBeenCalledWith(['add', '@scope/package@1.0.0'], {
  //     cwd: process.cwd(),
  //     stdio: 'inherit',
  //   });
  //   expect(result).toEqual({
  //     success: true,
  //     installedIdentifier: '@scope/package',
  //   });
  // });

  // it('should handle GitHub packages with existing hash in name', async () => {
  //   mockExeca.mockResolvedValue({});

  //   const result = await executeInstallation('github:owner/repo#existing-ref', 'new-ref');

  //   expect(mockExeca).toHaveBeenCalledWith(
  //     'bun',
  //     ['add', 'github:owner/repo#existing-ref#new-ref'],
  //     {
  //       cwd: process.cwd(),
  //       stdio: 'inherit',
  //     }
  //   );
  //   expect(result).toEqual({
  //     success: true,
  //     installedIdentifier: '@owner/repo',
  //   });
  // });
  // });
});
