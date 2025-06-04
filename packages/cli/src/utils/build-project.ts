import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@elizaos/core';
import { execa } from 'execa';
import { isMonorepoContext } from './get-package-info';
import { runBunCommand } from './run-bun';

/**
 * Builds a project or plugin in the specified directory using the most appropriate available build method.
 *
 * Attempts to run the build script from `package.json` using `bun` or `npm`, or falls back to building with the TypeScript compiler if a `tsconfig.json` is present. Throws an error if no suitable build method is found or if all build attempts fail.
 *
 * @param cwd - The directory containing the project or plugin to build.
 * @param isPlugin - Set to `true` if building a plugin; otherwise, builds a project.
 *
 * @throws {Error} If no build method can be determined or if all build attempts fail.
 */
export async function buildProject(cwd: string, isPlugin = false) {
  logger.info(`Building ${isPlugin ? 'plugin' : 'project'}...`);

  // Validate that the project directory exists
  if (!fs.existsSync(cwd)) {
    throw new Error(`Project directory ${cwd} does not exist or package.json is missing.`);
  }

  const packageJsonPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    logger.warn(`package.json not found at ${packageJsonPath}. Cannot determine build method.`);
    throw new Error(`Project directory ${cwd} does not exist or package.json is missing.`);
  }

  // Clean dist directory if it exists
  const distPath = path.join(cwd, 'dist');
  if (fs.existsSync(distPath)) {
    await fs.promises.rm(distPath, { recursive: true, force: true });
    logger.debug(`Cleaned previous build artifacts from ${distPath}`);
  }

  // Check if we're in a monorepo
  const inMonorepo = await isMonorepoContext();
  if (inMonorepo) {
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
