import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '@elizaos/core';
import { isQuietMode } from './spinner-utils';

// Define __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  // Ensure paths are properly resolved as absolute paths
  const resolvedSrc = path.resolve(src);
  const resolvedDest = path.resolve(dest);

  // Create destination directory if it doesn't exist
  await fs.mkdir(resolvedDest, { recursive: true });

  // Read source directory
  const entries = await fs.readdir(resolvedSrc, { withFileTypes: true });

  // Separate files and directories for different processing strategies
  const files: typeof entries = [];
  const directories: typeof entries = [];

  for (const entry of entries) {
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
      directories.push(entry);
    } else {
      files.push(entry);
    }
  }

  // Process files in parallel (up to 10 concurrent operations)
  const MAX_CONCURRENT_FILES = 10;
  const filePromises: Promise<void>[] = [];

  for (let i = 0; i < files.length; i += MAX_CONCURRENT_FILES) {
    const batch = files.slice(i, i + MAX_CONCURRENT_FILES);
    const batchPromises = batch.map(async (entry) => {
      const srcPath = path.join(resolvedSrc, entry.name);
      const destPath = path.join(resolvedDest, entry.name);
      await fs.copyFile(srcPath, destPath);
    });
    filePromises.push(...batchPromises);
  }

  // Wait for all file copies to complete
  await Promise.all(filePromises);

  // Process directories sequentially to avoid too much recursion depth
  // but still get benefits from parallel file copying within each directory
  for (const entry of directories) {
    const srcPath = path.join(resolvedSrc, entry.name);
    const destPath = path.join(resolvedDest, entry.name);
    await copyDir(srcPath, destPath, exclude);
  }
}

/**
 * Map template types to actual package names
 */
function getPackageName(templateType: string): string {
  switch (templateType) {
    case 'project-tee-starter':
      return 'project-tee-starter';
    case 'plugin':
      return 'plugin-starter';
    case 'plugin-quick':
      return 'plugin-quick-starter';
    case 'project':
    case 'project-starter':
    default:
      return 'project-starter';
  }
}

/**
 * Copy a project or plugin template to target directory
 */
export async function copyTemplate(
  templateType: 'project' | 'project-starter' | 'project-tee-starter' | 'plugin' | 'plugin-quick',
  targetDir: string
) {
  const packageName = getPackageName(templateType);

  // Try multiple locations to find templates, handling different runtime environments
  const possibleTemplatePaths = [
    // 1. Direct path from source directory (for tests and development)
    path.resolve(__dirname, '../../templates', packageName),
    // 2. Production: templates bundled with the CLI dist
    path.resolve(
      path.dirname(require.resolve('@elizaos/cli/package.json')),
      'dist',
      'templates',
      packageName
    ),
    // 3. Development/Test: templates in the CLI package root
    path.resolve(
      path.dirname(require.resolve('@elizaos/cli/package.json')),
      'templates',
      packageName
    ),
    // 4. Fallback: relative to current module (for built dist)
    path.resolve(__dirname, '..', 'templates', packageName),
    // 5. Additional fallback: relative to dist directory
    path.resolve(__dirname, '..', '..', 'templates', packageName),
  ];

  let templateDir: string | null = null;
  for (const possiblePath of possibleTemplatePaths) {
    if (existsSync(possiblePath)) {
      templateDir = possiblePath;
      break;
    }
  }

  if (!templateDir) {
    throw new Error(
      `Template '${packageName}' not found. Searched in:\n${possibleTemplatePaths.join('\n')}`
    );
  }

  logger.debug(`Copying ${templateType} template from ${templateDir} to ${targetDir}`);

  // Copy template files as-is
  await copyDir(templateDir, targetDir);

  // For plugin templates, replace hardcoded "plugin-starter" strings in source files
  if (templateType === 'plugin' || templateType === 'plugin-quick') {
    const pluginNameFromPath = path.basename(targetDir);
    await replacePluginNameInFiles(targetDir, pluginNameFromPath);
  }

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
          if (!isQuietMode()) {
            logger.info(`Setting ${depName} to use version ${cliPackageVersion}`);
          }
          packageJson.dependencies[depName] = 'latest';
        }
      }
    }

    if (packageJson.devDependencies) {
      for (const depName of Object.keys(packageJson.devDependencies)) {
        if (depName.startsWith('@elizaos/')) {
          if (!isQuietMode()) {
            logger.info(`Setting dev dependency ${depName} to use version ${cliPackageVersion}`);
          }
          packageJson.devDependencies[depName] = 'latest';
        }
      }
    }

    // Update the package name to use the actual name provided by the user
    const projectNameFromPath = path.basename(targetDir);

    if (packageJson.name !== projectNameFromPath) {
      packageJson.name = projectNameFromPath;
      if (!isQuietMode()) {
        logger.info(`Setting package name to ${projectNameFromPath}`);
      }
    }

    // Write the updated package.json (dependency versions and plugin name changed)
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
    logger.debug('Updated package.json with latest dependency versions');
  } catch (error) {
    logger.error(`Error updating package.json: ${error}`);
  }

  logger.debug(`${templateType} template copied successfully`);
}

/**
 * Replace hardcoded "plugin-starter" or "plugin-quick-starter" strings in source files with the actual plugin name
 */
async function replacePluginNameInFiles(targetDir: string, pluginName: string): Promise<void> {
  const filesToProcess = [
    'src/index.ts',
    'src/plugin.ts',
    'src/__tests__/plugin.test.ts',
    '__tests__/plugin.test.ts',
    'e2e/starter-plugin.test.ts',
    'README.md',
    // package.json name is handled by the publish command
  ];

  // Process files in parallel
  const promises = filesToProcess.map(async (filePath) => {
    const fullPath = path.join(targetDir, filePath);

    try {
      if (
        await fs
          .access(fullPath)
          .then(() => true)
          .catch(() => false)
      ) {
        let content = await fs.readFile(fullPath, 'utf8');

        // Replace both plugin-starter and plugin-quick-starter with the actual plugin name
        content = content.replace(/plugin-starter/g, pluginName);
        content = content.replace(/plugin-quick-starter/g, pluginName);

        await fs.writeFile(fullPath, content, 'utf8');
        logger.debug(`Updated plugin name in ${filePath}`);
      }
    } catch (error) {
      logger.warn(
        `Could not update ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  await Promise.all(promises);
}
