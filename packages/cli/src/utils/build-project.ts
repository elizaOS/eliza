import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@elizaos/core';
import { execa } from 'execa';
import { isMonorepoContext } from '@/src/utils';

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

  // Check if we're in a monorepo
  const inMonorepo = await isMonorepoContext();
  if (inMonorepo) {
    logger.info('Detected monorepo structure, skipping install');
  }

  try {
    // First check if the package.json has a build script
    const packageJsonPath = path.join(cwd, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (packageJson.scripts?.build) {
        // Package has a build script, use it
        logger.info('Using build script from package.json');

        try {
          // Try with bun first
          logger.debug('Attempting to build with bun...');
          await execa('bun', ['run', 'build'], { cwd, stdio: 'inherit' });
          logger.info('Build completed successfully with bun');
          return;
        } catch (bunError) {
          logger.debug(`Bun build failed, falling back to npm: ${bunError}`);

          try {
            // Fall back to npm if bun fails
            logger.debug('Attempting to build with npm...');
            await execa('npm', ['run', 'build'], { cwd, stdio: 'inherit' });
            logger.info('Build completed successfully with npm');
            return;
          } catch (npmError) {
            logger.debug(`npm build failed: ${npmError}`);
            throw new Error(`Failed to build using npm: ${npmError}`);
          }
        }
      }
    }

    // If we get here, no build script was found or it failed
    logger.warn('No build script found in package.json, trying default build commands');

    // For TypeScript projects, try tsc
    const tsconfigPath = path.join(cwd, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
      try {
        logger.debug('Found tsconfig.json, attempting to build with tsc...');
        await execa('npx', ['tsc', '--build'], { cwd, stdio: 'inherit' });
        logger.info('Build completed successfully with tsc');
        return;
      } catch (tscError) {
        logger.debug(`tsc build failed: ${tscError}`);
      }
    }

    // If all else fails, throw an error
    throw new Error('Could not determine how to build the project');
  } catch (error) {
    logger.error(`Failed to build ${isPlugin ? 'plugin' : 'project'}: ${error}`);
    throw error;
  }
}
