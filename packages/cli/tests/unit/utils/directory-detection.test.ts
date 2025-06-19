import { describe, it, expect, mock, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { 
  detectDirectoryType,
  isValidForUpdates
} from '../../../src/utils/directory-detection';

// Mock fs
mock.module('node:fs', () => ({
  existsSync: mock(() => true),
  readFileSync: mock(() => '{}'),
  statSync: mock(() => ({ isDirectory: () => true }))
}));

// Mock UserEnvironment
mock.module('../../../src/utils/user-environment', () => ({
  UserEnvironment: {
    getInstance: mock(() => ({
      findMonorepoRoot: mock()
    }))
  }
}));

describe('directory-detection', () => {
  
  describe('detectDirectoryType', () => {
    it('should detect elizaos project', () => {
      const mockPackageJson = {
        name: 'my-project',
        packageType: 'project',
        dependencies: {
          '@elizaos/core': '^1.0.0'
        }
      };
      
      fs.existsSync.mockImplementation(() => true);
      fs.readFileSync.mockImplementation(() => JSON.stringify(mockPackageJson));
      fs.readdirSync.mockImplementation(() => []);
      
      const result = detectDirectoryType('/test/path');
      
      expect(result.type).toBe('elizaos-project');
      expect(result.hasPackageJson).toBe(true);
      expect(result.hasElizaOSDependencies).toBe(true);
      expect(result.elizaPackageCount).toBe(1);
    });

    it('should detect elizaos plugin', () => {
      const mockPackageJson = {
        name: '@elizaos/plugin-test',
        packageType: 'plugin',
        dependencies: {
          '@elizaos/core': '^1.0.0'
        }
      };
      
      fs.existsSync.mockImplementation(() => true);
      fs.readFileSync.mockImplementation(() => JSON.stringify(mockPackageJson));
      fs.readdirSync.mockImplementation(() => []);
      
      const result = detectDirectoryType('/test/plugin');
      
      expect(result.type).toBe('elizaos-plugin');
      expect(result.hasPackageJson).toBe(true);
    });

    it('should detect monorepo root', () => {
      const mockPackageJson = {
        name: 'monorepo-root',
        workspaces: ['packages/*']
      };
      
      fs.existsSync.mockImplementation(() => true);
      fs.readFileSync.mockImplementation(() => JSON.stringify(mockPackageJson));
      fs.readdirSync.mockImplementation(() => []);
      
      // Mock UserEnvironment to return monorepo root
      const UserEnvironment = require('../../../src/utils/user-environment').UserEnvironment;
      UserEnvironment.getInstance().findMonorepoRoot.mockImplementation(() => '/test/monorepo');
      
      const result = detectDirectoryType('/test/monorepo');
      
      expect(result.type).toBe('elizaos-monorepo');
      expect(result.monorepoRoot).toBe('/test/monorepo');
    });

    it('should detect elizaos subdirectory in monorepo', () => {
      fs.existsSync.mockImplementation((filepath) => {
        // No package.json in subdirectory
        return String(filepath) !== path.join('/test/monorepo/subdir', 'package.json');
      });
      fs.readdirSync.mockImplementation(() => []);
      
      // Mock UserEnvironment to return monorepo root
      const UserEnvironment = require('../../../src/utils/user-environment').UserEnvironment;
      UserEnvironment.getInstance().findMonorepoRoot.mockImplementation(() => '/test/monorepo');
      
      const result = detectDirectoryType('/test/monorepo/subdir');
      
      expect(result.type).toBe('elizaos-subdir');
      expect(result.hasPackageJson).toBe(false);
      expect(result.monorepoRoot).toBe('/test/monorepo');
    });

    it('should return non-elizaos-dir for regular project', () => {
      const mockPackageJson = {
        name: 'regular-project',
        dependencies: {
          'express': '^4.0.0'
        }
      };
      
      fs.existsSync.mockImplementation(() => true);
      fs.readFileSync.mockImplementation(() => JSON.stringify(mockPackageJson));
      fs.readdirSync.mockImplementation(() => []);
      
      const result = detectDirectoryType('/test/regular');
      
      expect(result.type).toBe('non-elizaos-dir');
      expect(result.hasElizaOSDependencies).toBe(false);
    });

    it('should handle missing directory', () => {
      fs.existsSync.mockImplementation(() => false);
      
      const result = detectDirectoryType('/test/missing');
      
      expect(result.type).toBe('non-elizaos-dir');
      expect(result.hasPackageJson).toBe(false);
    });

    it('should handle invalid JSON in package.json', () => {
      fs.existsSync.mockImplementation(() => true);
      fs.readFileSync.mockImplementation(() => 'invalid json');
      fs.readdirSync.mockImplementation(() => []);
      
      const result = detectDirectoryType('/test/invalid');
      
      expect(result.type).toBe('non-elizaos-dir');
      expect(result.hasPackageJson).toBe(true);
    });

    it('should count multiple elizaos packages', () => {
      const mockPackageJson = {
        name: 'my-project',
        dependencies: {
          '@elizaos/core': '^1.0.0',
          '@elizaos/cli': '^1.0.0',
          '@elizaos/plugin-discord': '^1.0.0'
        }
      };
      
      fs.existsSync.mockImplementation(() => true);
      fs.readFileSync.mockImplementation(() => JSON.stringify(mockPackageJson));
      fs.readdirSync.mockImplementation(() => []);
      
      const result = detectDirectoryType('/test/path');
      
      expect(result.elizaPackageCount).toBe(3);
      expect(result.hasElizaOSDependencies).toBe(true);
    });

    it('should detect plugin by keywords', () => {
      const mockPackageJson = {
        name: 'custom-plugin',
        keywords: ['plugin', 'elizaos'],
        dependencies: {
          '@elizaos/core': '^1.0.0'
        }
      };
      
      fs.existsSync.mockImplementation(() => true);
      fs.readFileSync.mockImplementation(() => JSON.stringify(mockPackageJson));
      fs.readdirSync.mockImplementation(() => []);
      
      const result = detectDirectoryType('/test/plugin');
      
      expect(result.type).toBe('elizaos-plugin');
    });

    it('should handle unreadable directory', () => {
      fs.existsSync.mockImplementation(() => true);
      fs.readdirSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });
      
      const result = detectDirectoryType('/test/unreadable');
      
      expect(result.type).toBe('non-elizaos-dir');
      expect(result.hasPackageJson).toBe(false);
    });
  });

  describe('isValidForUpdates', () => {
    it('should return true for elizaos-project', () => {
      const info = {
        type: 'elizaos-project' as const,
        hasPackageJson: true,
        hasElizaOSDependencies: true,
        elizaPackageCount: 1
      };
      
      expect(isValidForUpdates(info)).toBe(true);
    });

    it('should return true for elizaos-plugin', () => {
      const info = {
        type: 'elizaos-plugin' as const,
        hasPackageJson: true,
        hasElizaOSDependencies: true,
        elizaPackageCount: 1
      };
      
      expect(isValidForUpdates(info)).toBe(true);
    });

    it('should return true for elizaos-monorepo', () => {
      const info = {
        type: 'elizaos-monorepo' as const,
        hasPackageJson: true,
        hasElizaOSDependencies: false,
        elizaPackageCount: 0
      };
      
      expect(isValidForUpdates(info)).toBe(true);
    });

    it('should return true for elizaos-subdir', () => {
      const info = {
        type: 'elizaos-subdir' as const,
        hasPackageJson: false,
        hasElizaOSDependencies: false,
        elizaPackageCount: 0
      };
      
      expect(isValidForUpdates(info)).toBe(true);
    });

    it('should return false for non-elizaos-dir', () => {
      const info = {
        type: 'non-elizaos-dir' as const,
        hasPackageJson: true,
        hasElizaOSDependencies: false,
        elizaPackageCount: 0
      };
      
      expect(isValidForUpdates(info)).toBe(false);
    });
  });
}); 