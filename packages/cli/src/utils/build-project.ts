import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@elizaos/core';
import { execa } from 'execa';
import { detectDirectoryType } from './directory-detection';
import { runBunCommand } from './run-bun';

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
    console.info('Skipping build in test mode');
    return;
  }

  logger.info(`Building ${isPlugin ? 'plugin' : 'project'} in ${cwd}...`);

  // Validate that the project directory exists and use centralized detection
  if (!fs.existsSync(cwd)) {
    throw new Error(`Project directory ${cwd} does not exist.`);
  }

  const dirInfo = detectDirectoryType(cwd);
  if (!dirInfo.hasPackageJson) {
    logger.warn(`package.json not found in ${cwd}. Cannot determine build method.`);
    throw new Error(`Project directory ${cwd} does not have package.json.`);
  }

  const packageJsonPath = path.join(cwd, 'package.json');

  // Clean dist directory if it exists
  const distPath = path.join(cwd, 'dist');
  if (fs.existsSync(distPath)) {
    await fs.promises.rm(distPath, { recursive: true, force: true });
    logger.debug(`Cleaned previous build artifacts from ${distPath}`);
  }

  // Check if we're in a monorepo
  const directoryInfo = detectDirectoryType(cwd);
  if (directoryInfo.monorepoRoot) {
    logger.debug('Detected monorepo structure, skipping install');
  }

  try {
    // Read package.json (we already validated it exists)
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    if (packageJson.scripts?.build) {
      // Package has a build script, use bun to run it
      logger.debug('Using build script from package.json with bun');

      try {
        logger.debug('Building with bun...');

        // Simple build - cleanup is handled at a higher level
        await runBunCommand(['run', 'build'], cwd);

        logger.info(`Build completed successfully`);
        return;
      } catch (buildError) {
        logger.debug(`Bun build failed: ${buildError}`);
        throw new Error(`Failed to build using bun: ${buildError}`);
      }
    }

    // If we get here, no build script was found
    logger.warn(`No build script found in ${packageJsonPath}. Attempting common build commands.`);

    // For TypeScript projects, try tsc with bunx
    const tsconfigPath = path.join(cwd, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
      try {
        logger.debug('Found tsconfig.json, attempting to build with bunx tsc...');
        await execa('bunx', ['tsc', '--build'], { cwd, stdio: 'inherit' });
        logger.info(`Build completed successfully`);
        return;
      } catch (tscError) {
        logger.debug(`bunx tsc build failed: ${tscError}`);
      }
    }

    // If all else fails, throw an error
    throw new Error('Could not determine how to build the project');
  } catch (error) {
    logger.error(`Failed to build ${isPlugin ? 'plugin' : 'project'}: ${error}`);
    throw error;
  }
}
