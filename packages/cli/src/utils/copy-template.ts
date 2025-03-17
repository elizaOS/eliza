import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '@elizaos/core';

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

  if (process.env.NODE_ENV === 'development') {
    // Use local packages during development
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

  logger.info(`Copying ${templateType} template from ${templateDir} to ${targetDir}`);

  // Copy template files
  await copyDir(templateDir, targetDir);

  // Update package.json with new name and dependency versions
  const packageJsonPath = path.join(targetDir, 'package.json');

  try {
    // get the package.json of this package
    const cliPackageJsonPath = path.resolve(
      path.dirname(require.resolve('@elizaos/cli/package.json')),
      'package.json'
    );

    const cliPackageJson = JSON.parse(await fs.readFile(cliPackageJsonPath, 'utf8'));

    // get the version of this package
    const cliPackageVersion = cliPackageJson.version;

    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

    // Set project name
    packageJson.name = name;

    // Process dependencies - set all @elizaos/* packages to use cliPackageVersion
    if (packageJson.dependencies) {
      for (const depName of Object.keys(packageJson.dependencies)) {
        if (depName.startsWith('@elizaos/')) {
          logger.info(`Setting ${depName} to use latest version dynamically`);
          packageJson.dependencies[depName] = cliPackageVersion;
        }
      }
    }

    // Process devDependencies if they exist
    if (packageJson.devDependencies) {
      for (const depName of Object.keys(packageJson.devDependencies)) {
        if (depName.startsWith('@elizaos/')) {
          logger.info(`Setting dev dependency ${depName} to use version ${cliPackageVersion}`);
          packageJson.devDependencies[depName] = cliPackageVersion;
        }
      }
    }

    // Write the updated package.json
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
    logger.success('Updated package.json with project name and latest dependencies');
  } catch (error) {
    logger.error(`Error updating package.json: ${error}`);
  }

  logger.success(`${templateType} template copied successfully`);
}

/**
 * Copy client dist files to the CLI package dist directory
 */
export async function copyClientDist() {
  logger.info('Copying client dist files to CLI package');

  // Determine source and destination paths
  const srcClientDist = path.resolve(process.cwd(), '../client/dist');
  const destClientDist = path.resolve(process.cwd(), './dist');

  // Create destination directory
  await fs.mkdir(destClientDist, { recursive: true });

  // Wait for source directory to exist and have files
  let retries = 0;
  const maxRetries = 10;
  const retryDelay = 1000; // 1 second

  while (retries < maxRetries) {
    if (existsSync(srcClientDist)) {
      const files = await fs.readdir(srcClientDist);
      if (files.length > 0) {
        break;
      }
    }

    logger.info(
      `Waiting for client dist files to be built (attempt ${retries + 1}/${maxRetries})...`
    );
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
    retries++;
  }

  // Check if source exists after retries
  if (!existsSync(srcClientDist)) {
    logger.error(`Client dist not found at ${srcClientDist} after ${maxRetries} attempts`);
    return;
  }

  // Copy client dist files
  await copyDir(srcClientDist, destClientDist);

  logger.success('Client dist files copied successfully');
}
