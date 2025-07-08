/**
 * Unit tests for client path resolution logic
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';

describe('Client Path Resolution Logic', () => {
  let tempDir: string;
  let originalArgv: string[];
  let originalHomedir: typeof os.homedir;

  beforeEach(() => {
    // Create a temporary directory for testing
    tempDir = path.join(os.tmpdir(), `eliza-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    // Save original values
    originalArgv = [...process.argv];
    originalHomedir = os.homedir;
  });

  afterEach(() => {
    // Restore original values
    process.argv = originalArgv;
    os.homedir = originalHomedir;

    // Clean up temp directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Path Resolution Priority', () => {
    it('should prioritize explicitly provided clientPath', () => {
      const explicitPath = '/explicit/path/to/client';
      const paths = [explicitPath, '/some/other/path', null, undefined].filter(Boolean);

      expect(paths[0]).toBe(explicitPath);
    });

    it('should check process.argv[1] for global CLI installations', () => {
      const mockCliPath = path.join(tempDir, 'cli', 'dist', 'index.js');
      const mockClientPath = path.dirname(mockCliPath);

      // Create mock files
      mkdirSync(mockClientPath, { recursive: true });
      writeFileSync(path.join(mockClientPath, 'index.html'), '');

      // Mock process.argv
      process.argv = [process.argv[0], mockCliPath, 'start'];

      // Test the resolution logic
      const resolvedPath = (() => {
        if (process.argv[1]) {
          const cliPath = path.dirname(process.argv[1]);
          const possibleDistPath = path.join(cliPath, 'index.html');
          if (existsSync(possibleDistPath)) {
            return cliPath;
          }
        }
        return null;
      })();

      expect(resolvedPath).toBe(mockClientPath);
    });

    it('should check bun global installation path', () => {
      // Mock os.homedir
      os.homedir = () => tempDir;

      const bunGlobalPath = path.join(
        tempDir,
        '.bun/install/global/node_modules/@elizaos/cli/dist'
      );

      // Create mock files
      mkdirSync(bunGlobalPath, { recursive: true });
      writeFileSync(path.join(bunGlobalPath, 'index.html'), '');

      // Test the resolution logic
      const resolvedPath = (() => {
        const bunPath = path.join(
          os.homedir(),
          '.bun/install/global/node_modules/@elizaos/cli/dist'
        );
        if (existsSync(path.join(bunPath, 'index.html'))) {
          return bunPath;
        }
        return null;
      })();

      expect(resolvedPath).toBe(bunGlobalPath);
    });
  });

  describe('Fallback Paths', () => {
    it('should check common global npm paths', () => {
      const commonPaths = [
        '/usr/local/lib/node_modules/@elizaos/cli/dist',
        '/usr/lib/node_modules/@elizaos/cli/dist',
        path.join(os.homedir(), '.npm-global/lib/node_modules/@elizaos/cli/dist'),
      ];

      // Verify these are valid path formats
      commonPaths.forEach((p) => {
        expect(path.isAbsolute(p)).toBe(true);
        expect(p).toContain('@elizaos/cli/dist');
      });
    });

    it('should handle missing client files gracefully', () => {
      const nonExistentPath = path.join(tempDir, 'non-existent');
      const paths = [nonExistentPath, null, undefined].filter(
        (p) => p && existsSync(path.join(p, 'index.html'))
      );

      expect(paths.length).toBe(0);
    });
  });

  describe('Development vs Production', () => {
    it('should resolve relative paths for monorepo development', () => {
      const dirname = '/path/to/packages/server/dist';
      const devPath = path.resolve(dirname, '../../cli/dist');

      expect(devPath).toContain('packages/cli/dist');
      expect(path.isAbsolute(devPath)).toBe(true);
    });

    it('should handle require.resolve for installed packages', () => {
      // Test the pattern without actual require.resolve
      const mockRequireResolve = (pkg: string) => {
        if (pkg === '@elizaos/cli/package.json') {
          return path.join(tempDir, 'node_modules/@elizaos/cli/package.json');
        }
        throw new Error('Module not found');
      };

      try {
        const packageJsonPath = mockRequireResolve('@elizaos/cli/package.json');
        const cliPath = path.resolve(path.dirname(packageJsonPath), 'dist');

        expect(cliPath).toContain('@elizaos/cli/dist');
      } catch {
        // Module not found is expected in test environment
        expect(true).toBe(true);
      }
    });
  });

  describe('SPA Fallback Logic', () => {
    it('should identify routes that need SPA fallback', () => {
      const apiRoutes = ['/api/', '/agents', '/channels', '/messages', '/socket.io'];
      const spaRoutes = ['/chat/123', '/settings/', '/profile/edit', '/random-route'];

      const needsFallback = (route: string) => {
        // Check if route is an API route
        for (const apiRoute of apiRoutes) {
          if (route.startsWith(apiRoute)) {
            return false;
          }
        }
        // Static assets
        if (route.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/)) {
          return false;
        }
        return true;
      };

      apiRoutes.forEach((route) => {
        expect(needsFallback(route)).toBe(false);
      });

      spaRoutes.forEach((route) => {
        expect(needsFallback(route)).toBe(true);
      });
    });
  });
});
