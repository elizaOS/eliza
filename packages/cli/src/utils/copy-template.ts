import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '@elizaos/core';
import { UserEnvironment } from './user-environment';

/**
 * Copy a directory recursively
 */
/**
 * Asynchronously copies the contents of a directory from a source path to a destination path, excluding specified files and directories.
 * If the destination directory does not exist, it will be created.
 *
 * @param {string} src - The path to the source directory.
 * @param {string} dest - The path to the destination directory.
 * @param {string[]} [exclude=[]] - An array of file and directory names to exclude from the copy operation.
 * @returns {Promise<void>} A Promise that resolves when the copy operation is complete.
 */
export async function copyDir(src: string, dest: string, exclude: string[] = []) {
  // Create destination directory if it doesn't exist
  await fs.mkdir(dest, { recursive: true });

  // Read source directory
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip excluded directories/files
    if (exclude.includes(entry.name)) {
      continue;
    }

    // Skip node_modules, .git directories and other build artifacts
    if (
      entry.name === 'node_modules' ||
      entry.name === '.git' ||
      entry.name === 'cache' ||
      entry.name === 'data' ||
      entry.name === 'generatedImages' ||
      entry.name === '.turbo'
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      // Recursively copy directory
      await copyDir(srcPath, destPath, exclude);
    } else {
      // Copy file
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Copy a project or plugin template to target directory
 */
export async function copyTemplate(
  templateType: 'project' | 'plugin',
  targetDir: string,
  name: string
) {
  // In development mode, use the actual packages
  let templateDir;
  const userEnv = UserEnvironment.getInstance();
  const pathsInfo = await userEnv.getPathInfo();

  if (process.env.NODE_ENV === 'development' && pathsInfo.monorepoRoot) {
    // Use monorepoRoot if in development and monorepoRoot is found
    logger.debug(
      `Development mode: Using monorepo root at ${pathsInfo.monorepoRoot} to find templates.`
    );
    templateDir = path.resolve(
      pathsInfo.monorepoRoot,
      'packages',
      templateType === 'project' ? 'project-starter' : 'plugin-starter'
    );
  } else if (process.env.NODE_ENV === 'development') {
    // Fallback for development if monorepoRoot is not found (e.g., running CLI from a strange location)
    logger.warn(
      'Development mode: monorepoRoot not found. Falling back to process.cwd() for template path. This might be unreliable.'
    );
    templateDir = path.resolve(
      process.cwd(),
      'packages',
      templateType === 'project' ? 'project-starter' : 'plugin-starter'
    );
  } else {
    // In production, use the templates directory from the CLI package
    templateDir = path.resolve(
      path.dirname(require.resolve('@elizaos/cli/package.json')),
      'templates',
      templateType === 'project' ? 'project-starter' : 'plugin-starter'
    );
  }

  logger.debug(`Copying ${templateType} template from ${templateDir} to ${targetDir}`);

  // Copy template files as-is
  await copyDir(templateDir, targetDir);

  // Update package.json with dependency versions only (leave placeholders intact)
  const packageJsonPath = path.join(targetDir, 'package.json');

  try {
    // Get the CLI package version for dependency updates
    const cliPackageJsonPath = path.resolve(
      path.dirname(require.resolve('@elizaos/cli/package.json')),
      'package.json'
    );

    const cliPackageJson = JSON.parse(await fs.readFile(cliPackageJsonPath, 'utf8'));
    const cliPackageVersion = cliPackageJson.version;

    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

    // Remove private field from template package.json since templates should be usable by users
    if (packageJson.private) {
      delete packageJson.private;
      logger.debug('Removed private field from template package.json');
    }

    // Only update dependency versions - leave everything else unchanged
    if (packageJson.dependencies) {
      for (const depName of Object.keys(packageJson.dependencies)) {
        if (depName.startsWith('@elizaos/')) {
          logger.debug(`Setting ${depName} to use version ${cliPackageVersion}`);
          packageJson.dependencies[depName] = cliPackageVersion.includes('beta')
            ? 'beta'
            : 'latest';
        }
      }
    }

    if (packageJson.devDependencies) {
      for (const depName of Object.keys(packageJson.devDependencies)) {
        if (depName.startsWith('@elizaos/')) {
          logger.debug(`Setting dev dependency ${depName} to use version ${cliPackageVersion}`);
          packageJson.devDependencies[depName] = cliPackageVersion.includes('beta')
            ? 'beta'
            : 'latest';
        }
      }
    }

    // Write the updated package.json (only dependency versions changed)
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
    logger.debug('Updated package.json with latest dependency versions');
  } catch (error) {
    logger.error(`Error updating package.json: ${error}`);
  }

  logger.debug(`${templateType} template copied successfully`);
}

/**
 * Copy client dist files to the CLI package dist directory
 */
export async function copyClientDist() {
  logger.info('Copying client dist files to CLI package');

  const srcClientDist = path.resolve(process.cwd(), '../client/dist');
  const destClientDist = path.resolve(process.cwd(), './dist');
  const indexSrc = path.join(srcClientDist, 'index.html');
  const indexDest = path.join(destClientDist, 'index.html');

  await fs.mkdir(destClientDist, { recursive: true });

  // Wait specifically for index.html to appear
  let retries = 0;
  const maxRetries = 10;
  const retryDelay = 1000;
  while (retries < maxRetries) {
    if (existsSync(indexSrc)) {
      break;
    }
    logger.info(`Waiting for client index.html (attempt ${retries + 1}/${maxRetries})…`);
    await new Promise((r) => setTimeout(r, retryDelay));
    retries++;
  }

  if (!existsSync(indexSrc)) {
    logger.error(`index.html not found at ${indexSrc} after ${maxRetries} attempts`);
    return;
  }

  // Copy everything
  await copyDir(srcClientDist, destClientDist);

  // Verify it made it into CLI dist
  if (!existsSync(indexDest)) {
    logger.error(`index.html missing in CLI dist at ${indexDest}`);
    return;
  }

  logger.success('Client dist files copied successfully');
}
