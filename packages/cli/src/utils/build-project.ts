import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@elizaos/core';
import { bunExec } from './bun-exec';
import { detectDirectoryType } from './directory-detection';
import { runBunWithSpinner } from './spinner-utils';
import colors from 'yoctocolors';

/**
 * Builds a project or plugin in the specified directory using the most appropriate available build method.
 *
 * Attempts to run the build script from `package.json` using `bun` or `npm`, or falls back to building
 * with the TypeScript compiler if a `tsconfig.json` is present. Throws an error if no suitable build
 * method is found or if all build attempts fail.
 *
 * note: cleanup on ctrl-c is handled by the calling function (creators.ts) not here
 *
 * @param cwd - The directory containing the project or plugin to build.
 * @param isPlugin - Set to `true` if building a plugin; otherwise, builds a project.
 *
 * @throws {Error} If no build method can be determined or if all build attempts fail.
 */
export async function buildProject(cwd: string = process.cwd(), isPlugin = false) {
  if (process.env.ELIZA_TEST_MODE) {
    return;
  }

  // Validate that the project directory exists and use centralized detection
  if (!fs.existsSync(cwd)) {
    throw new Error(`Project directory ${cwd} does not exist.`);
  }

  const dirInfo = detectDirectoryType(cwd);
  if (!dirInfo.hasPackageJson) {
    throw new Error(`Project directory ${cwd} does not have package.json.`);
  }

  const packageJsonPath = path.join(cwd, 'package.json');

  // Clean dist directory if it exists
  const distPath = path.join(cwd, 'dist');
  if (fs.existsSync(distPath)) {
    await fs.promises.rm(distPath, { recursive: true, force: true });
  }

  const projectType = isPlugin ? 'plugin' : 'project';

  try {
    // Read package.json (we already validated it exists)
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    if (packageJson.scripts?.build) {
      // Package has a build script, use bun to run it
      const result = await runBunWithSpinner(['run', 'build'], cwd, {
        spinnerText: `Building ${projectType}...`,
        successText: colors.green(
          `✓ ${projectType.charAt(0).toUpperCase() + projectType.slice(1)} built successfully`
        ),
        errorText: `Failed to build ${projectType}`,
      });

      if (!result.success) {
        throw result.error || new Error(`Failed to build using bun`);
      }
      return;
    }

    // If we get here, no build script was found
    // For TypeScript projects, try tsc with bunx
    const tsconfigPath = path.join(cwd, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
      try {
        const result = await bunExec('bunx', ['tsc', '--build'], {
          cwd,
        });
        if (result.success) {
          return;
        } else {
          throw new Error(`bunx tsc build failed: ${result.stderr || result.stdout}`);
        }
      } catch (tscError) {
        throw new Error(`bunx tsc build failed: ${tscError}`);
      }
    }

    // If all else fails, throw an error
    throw new Error('Could not determine how to build the project');
  } catch (error) {
    throw error;
  }
}
