import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 1. Define mock functions using vi.hoisted to ensure they are initialized before vi.mock calls
const { mockRunBunCommand, mockIsMonorepoContext, mockExeca, mockLogger } = vi.hoisted(() => {
  return {
    mockRunBunCommand: vi.fn(),
    mockIsMonorepoContext: vi.fn(),
    mockExeca: vi.fn(), // For npm/tsc fallbacks
    mockLogger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
  };
});

// 2. Apply mocks using vi.mock() for all external dependencies of the SUT
vi.mock('@elizaos/core', () => ({ logger: mockLogger }));
vi.mock('execa', () => ({ execa: mockExeca }));
// Path from test/utils/build-project.test.ts to src/utils/run-bun.ts
vi.mock('../../src/utils/run-bun', () => ({ runBunCommand: mockRunBunCommand }));
// Path from test/utils/build-project.test.ts to src/utils/get-package-info.ts
vi.mock('../../src/utils/get-package-info', () => ({ isMonorepoContext: mockIsMonorepoContext }));

// 3. Import the SUT (System Under Test) AFTER mocks are defined
import { buildProject } from '../../src/utils/build-project';

describe('build-project', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create a temporary directory for each test
    tempDir = await mkdtemp(join(tmpdir(), 'build-project-test-'));

    // Reset mocks (their history and any specific implementations)
    mockRunBunCommand.mockReset().mockResolvedValue(undefined);
    mockIsMonorepoContext.mockReset().mockResolvedValue(false);
    mockExeca.mockReset().mockResolvedValue({ stdout: '', stderr: '' }); // Default success for execa

    // Reset logger mock functions
    mockLogger.info.mockReset();
    mockLogger.debug.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    mockLogger.success.mockReset();
  });

  afterEach(async () => {
    // Clean up temporary directory
    if (tempDir && existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('buildProject scenarios', () => {
    it('should build project successfully with default settings', async () => {
      const projectDir = join(tempDir, 'test-project');
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'package.json'),
        JSON.stringify({
          name: 'test-project',
          version: '1.0.0',
          scripts: { build: 'echo "building..."' },
        })
      );

      await buildProject(projectDir);

      expect(mockRunBunCommand).toHaveBeenCalledWith(['run', 'build'], projectDir);
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Building project'));
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Build completed successfully')
      );
    });

    it('should build plugin with plugin-specific settings', async () => {
      const pluginDir = join(tempDir, 'test-plugin');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, 'package.json'),
        JSON.stringify({
          name: 'test-plugin',
          version: '1.0.0',
          scripts: { build: 'echo "building plugin..."' },
        })
      );

      await buildProject(pluginDir, true);

      expect(mockRunBunCommand).toHaveBeenCalledWith(['run', 'build'], pluginDir);
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Building plugin'));
      expect(mockLogger.info).toHaveBeenCalledWith(
        // Ensure success is logged for plugins too
        expect.stringContaining('Build completed successfully')
      );
    });

    it('should handle missing package.json gracefully', async () => {
      const projectDir = join(tempDir, 'no-package-json');
      await mkdir(projectDir, { recursive: true });

      await expect(buildProject(projectDir)).rejects.toThrow(
        `Project directory ${projectDir} does not exist or package.json is missing.`
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`package.json not found at ${join(projectDir, 'package.json')}`)
      );
    });

    it('should handle build failures from runBunCommand', async () => {
      const projectDir = join(tempDir, 'failing-project-bun');
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'package.json'),
        JSON.stringify({
          name: 'failing-project-bun',
          version: '1.0.0',
          scripts: { build: 'echo "build script"' },
        })
      );

      const bunFailError = new Error('Bun build failed');
      mockRunBunCommand.mockRejectedValue(bunFailError);

      // Make npm fallback also fail for this specific test
      mockExeca.mockImplementation(async (command, args) => {
        if (command === 'npm' && args.includes('build')) {
          throw new Error('NPM fallback also failed');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(buildProject(projectDir)).rejects.toThrow(
        'Failed to build using npm: Error: NPM fallback also failed'
      );

      expect(mockRunBunCommand).toHaveBeenCalled();
      expect(mockExeca).toHaveBeenCalledWith('npm', ['run', 'build'], expect.anything());
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'Failed to build project: Error: Failed to build using npm: Error: NPM fallback also failed'
        )
      );
    });

    it('should fallback to npm and handle npm build failure', async () => {
      const projectDir = join(tempDir, 'failing-project-npm');
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'package.json'),
        JSON.stringify({
          name: 'failing-project-npm',
          version: '1.0.0',
          scripts: { build: 'echo "build script"' },
        })
      );

      mockRunBunCommand.mockRejectedValue(new Error('Bun layer failed')); // Bun fails first
      mockExeca.mockImplementation(async (command, args) => {
        // execa for npm
        if (command === 'npm' && args.includes('build')) {
          throw new Error('NPM build failed');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(buildProject(projectDir)).rejects.toThrow(
        'Failed to build using npm: Error: NPM build failed'
      );
      expect(mockRunBunCommand).toHaveBeenCalled();
      expect(mockExeca).toHaveBeenCalledWith('npm', ['run', 'build'], expect.anything());
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'Failed to build project: Error: Failed to build using npm: Error: NPM build failed'
        )
      );
    });

    it('should use specified package manager (bun via runBunCommand)', async () => {
      const projectDir = join(tempDir, 'bun-project');
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'package.json'),
        JSON.stringify({
          name: 'bun-project',
          version: '1.0.0',
          scripts: { build: 'bun run build-script' },
        })
      );

      await buildProject(projectDir);
      expect(mockRunBunCommand).toHaveBeenCalledWith(['run', 'build'], projectDir);
    });

    it('should attempt tsc build if no build script and tsconfig.json exists', async () => {
      const projectDir = join(tempDir, 'typescript-project-no-script');
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        // No build script
        join(projectDir, 'package.json'),
        JSON.stringify({ name: 'typescript-project-no-script', version: '1.0.0', scripts: {} })
      );
      await writeFile(
        // tsconfig exists
        join(projectDir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { target: 'es2020' } })
      );

      mockExeca.mockResolvedValue({ stdout: '', stderr: '' }); // tsc build succeeds

      await buildProject(projectDir);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`No build script found in ${join(projectDir, 'package.json')}`)
      );
      expect(mockExeca).toHaveBeenCalledWith(
        'npx',
        ['tsc', '--build'],
        expect.objectContaining({ cwd: projectDir })
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Build completed successfully');
    });

    it('should handle tsc build failure', async () => {
      const projectDir = join(tempDir, 'typescript-project-tsc-fail');
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'package.json'),
        JSON.stringify({ name: 'typescript-project-tsc-fail', version: '1.0.0', scripts: {} })
      );
      await writeFile(
        join(projectDir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { target: 'es2020' } })
      );

      mockExeca.mockImplementation(async (command, args) => {
        if (command === 'npx' && args.includes('tsc')) {
          throw new Error('TSC build failed');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(buildProject(projectDir)).rejects.toThrow(
        'Could not determine how to build the project'
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`No build script found in ${join(projectDir, 'package.json')}`)
      );
      expect(mockExeca).toHaveBeenCalledWith(
        'npx',
        ['tsc', '--build'],
        expect.objectContaining({ cwd: projectDir })
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'Failed to build project: Error: Could not determine how to build the project'
        )
      );
    });

    it('should validate project directory exists', async () => {
      const nonExistentDir = join(tempDir, 'nonexistent');
      await expect(buildProject(nonExistentDir)).rejects.toThrow(
        `Project directory ${nonExistentDir} does not exist or package.json is missing.`
      );
    });

    it('should clean build artifacts before building if dist exists', async () => {
      const projectDir = join(tempDir, 'project-with-dist');
      const distDir = join(projectDir, 'dist');
      await mkdir(projectDir, { recursive: true });
      await mkdir(distDir, { recursive: true }); // Create dist
      await writeFile(join(distDir, 'old-file.js'), 'console.log("old");');
      await writeFile(
        join(projectDir, 'package.json'),
        JSON.stringify({
          name: 'project-with-dist',
          version: '1.0.0',
          scripts: { build: 'echo "building..."' },
        })
      );

      await buildProject(projectDir);

      expect(existsSync(distDir)).toBe(false); // Check it was removed
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining(`Cleaned previous build artifacts from ${distDir}`)
      );
      expect(mockRunBunCommand).toHaveBeenCalledWith(['run', 'build'], projectDir);
    });

    it('should not attempt to clean if dist does not exist', async () => {
      const projectDir = join(tempDir, 'project-no-dist');
      await mkdir(projectDir, { recursive: true }); // dist not created
      await writeFile(
        join(projectDir, 'package.json'),
        JSON.stringify({
          name: 'project-no-dist',
          version: '1.0.0',
          scripts: { build: 'echo "building..."' },
        })
      );

      await buildProject(projectDir);
      // Check that fs.promises.rm was NOT called for distPath (difficult to assert directly without spying on fs.promises.rm)
      // Instead, we can check that logger.debug for cleaning was not called.
      expect(mockLogger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('Cleaned previous build artifacts')
      );
      expect(mockRunBunCommand).toHaveBeenCalledWith(['run', 'build'], projectDir);
    });

    it('should handle monorepo projects', async () => {
      mockIsMonorepoContext.mockResolvedValue(true);
      const projectDir = join(tempDir, 'monorepo-project');
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'package.json'),
        JSON.stringify({
          name: 'monorepo-project',
          version: '1.0.0',
          scripts: { build: 'echo "building monorepo project..."' },
        })
      );

      await buildProject(projectDir);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Detected monorepo structure, skipping install'
      );
      expect(mockRunBunCommand).toHaveBeenCalledWith(['run', 'build'], projectDir);
    });

    it('should warn if no build script found in package.json AND no tsconfig.json', async () => {
      const projectDir = join(tempDir, 'no-build-script-no-tsconfig');
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'package.json'),
        JSON.stringify({
          name: 'no-build-script-no-tsconfig',
          version: '1.0.0',
          scripts: { test: 'echo "testing..."' }, // No build script
        })
      );
      // No tsconfig.json created for this test

      await expect(buildProject(projectDir)).rejects.toThrow(
        'Could not determine how to build the project'
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`No build script found in ${join(projectDir, 'package.json')}`)
      );
    });

    // Renamed original "should provide detailed error information on failure from runBunCommand"
    // as it's covered by "should handle build failures from runBunCommand"
    it('should throw if all build methods fail', async () => {
      const projectDir = join(tempDir, 'all-fail-project');
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'package.json'),
        JSON.stringify({
          name: 'all-fail-project',
          version: '1.0.0',
          scripts: { build: 'echo "build script"' }, // Has build script
        })
      );

      mockRunBunCommand.mockRejectedValue(new Error('Bun layer failed'));
      mockExeca.mockImplementation(async (command) => {
        // Covers both npm and tsc fallback attempts
        throw new Error(`Execa ${command} failed`);
      });

      // Even though package.json has a build script, if bun and npm attempts (routed via execa mock) fail,
      // and if there was a tsconfig, tsc would also fail.
      // The final error comes from the catch-all in buildProject or the npm failure.
      // Given the current buildProject logic, if bun fails, it tries npm. If npm fails, it throws that npm error.
      await expect(buildProject(projectDir)).rejects.toThrow(
        'Failed to build using npm: Error: Execa npm failed'
      );
    });
  });
});
