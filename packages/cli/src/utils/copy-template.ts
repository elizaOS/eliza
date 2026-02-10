/**
 * Template copying utility used at runtime by `elizaos create`.
 *
 * ## .gitignore / .npmignore — READ BEFORE MODIFYING
 *
 * New projects MUST have a `.gitignore`.  The file can be lost at several
 * points in the build-to-runtime pipeline:
 *
 *   • `copy-templates.ts` (pre-build) copies from monorepo source into
 *     `packages/cli/templates/` — fs-extra may silently drop the file.
 *   • `copyAssets` (post-build) copies from `templates/` into `dist/templates/`
 *     — Node's `fs.cp` may also drop it in certain Bun versions.
 *   • This file (`copyTemplate`) copies the resolved template to the user's
 *     target directory using `cpSync`.
 *
 * After `cpSync` we explicitly check and recreate `.gitignore` from
 * `.npmignore` or a default.  The `[COPY-TPL]` console.log lines are CI
 * diagnostics — they let us trace exactly where the file was lost if a test
 * fails.  Do NOT remove them without confirming CI still passes on Ubuntu.
 *
 * See also: `packages/cli/src/commands/create/actions/creators.ts` which calls
 * `ensureGitignore()` as a final safety-net after this function returns.
 */
import { existsSync, copyFileSync, writeFileSync, cpSync, mkdirSync, unlinkSync } from 'node:fs';
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
    // 2. Production: when running from dist, templates are at the same level
    path.resolve(__dirname, '../templates', packageName),
    // 3. Alternative production path (if utils is nested in dist)
    path.resolve(__dirname, '../../templates', packageName),
    // 4. Development: templates at package root
    path.resolve(__dirname, '../../../templates', packageName),
    // 5. Fallback for various directory structures
    path.resolve(__dirname, 'templates', packageName),
    // 6. Fallback to monorepo packages (when templates haven't been copied yet)
    path.resolve(__dirname, '../../../..', packageName),
    // 7. Alternative monorepo package path (from utils to packages directory)
    path.resolve(__dirname, '../../../../packages', packageName),
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

  // --- .gitignore / .npmignore copy pipeline ---
  //
  // Diagnostics are written to a JSON file inside the target directory AND to
  // stderr.  The JSON file is written IMMEDIATELY after mkdirSync and updated
  // at each step, so even if the function crashes midway we can see how far
  // it got.  stderr is used because clack spinners suppress stdout.
  const srcGitignore = path.join(templateDir, '.gitignore');
  const srcNpmignore = path.join(templateDir, '.npmignore');
  const diag: Record<string, unknown> = {
    phase: 'init',
    calledAt: Date.now(),
    __dirname,
    templateDir,
    targetDir,
    srcGitignoreExists: existsSync(srcGitignore),
    srcNpmignoreExists: existsSync(srcNpmignore),
  };

  const diagPath = path.join(targetDir, '.copy-template-diag.json');

  // Helper: persist current diag state to disk (best-effort)
  const flushDiag = () => {
    try {
      writeFileSync(diagPath, JSON.stringify(diag, null, 2));
    } catch {
      // best-effort — disk/permission issues shouldn't kill the template copy
    }
  };

  // Helper: also write to stderr so tests can capture it even if clack
  // suppresses stdout.
  const stderrLog = (msg: string) => {
    try {
      process.stderr.write(`[COPY-TPL] ${msg}\n`);
    } catch {
      // best-effort
    }
  };

  // Create target directory and write initial diagnostic IMMEDIATELY
  mkdirSync(targetDir, { recursive: true });
  flushDiag();
  stderrLog(`START templateDir=${templateDir} targetDir=${targetDir}`);

  // Copy template files using Node's built-in cpSync for reliable dotfile
  // handling.  The previous custom copyDir (async readdir + copyFile) silently
  // dropped dotfiles in certain Bun versions on Linux CI.
  const SKIP_NAMES = new Set([
    'node_modules',
    '.git',
    'cache',
    'data',
    'generatedImages',
    '.turbo',
  ]);

  try {
    cpSync(templateDir, targetDir, {
      recursive: true,
      filter: (src: string) => !SKIP_NAMES.has(path.basename(src)),
    });
    diag.cpSyncOk = true;
  } catch (cpErr) {
    diag.cpSyncOk = false;
    diag.cpSyncError = cpErr instanceof Error ? cpErr.message : String(cpErr);
    stderrLog(`cpSync ERROR: ${diag.cpSyncError}`);
    // cpSync may have partially copied — continue to salvage what we can
  }

  diag.phase = 'after-cpsync';
  const gitignorePath = path.join(targetDir, '.gitignore');
  const npmignorePath = path.join(targetDir, '.npmignore');
  diag.afterCpSync_gitignore = existsSync(gitignorePath);
  diag.afterCpSync_npmignore = existsSync(npmignorePath);
  flushDiag();
  stderrLog(
    `after-cpSync gitignore=${diag.afterCpSync_gitignore} npmignore=${diag.afterCpSync_npmignore}`
  );

  // Layer 1: If cpSync missed .gitignore but the source has it, copy explicitly
  if (!existsSync(gitignorePath) && existsSync(srcGitignore)) {
    try {
      copyFileSync(srcGitignore, gitignorePath);
      diag.layer1 = 'copied from source .gitignore';
    } catch (e) {
      diag.layer1Error = e instanceof Error ? e.message : String(e);
    }
  }

  // Layer 1b: Same for .npmignore
  if (!existsSync(npmignorePath) && existsSync(srcNpmignore)) {
    try {
      copyFileSync(srcNpmignore, npmignorePath);
      diag.layer1b = 'copied from source .npmignore';
    } catch (e) {
      diag.layer1bError = e instanceof Error ? e.message : String(e);
    }
  }

  // Layer 2: If still missing, create .gitignore from .npmignore
  if (!existsSync(gitignorePath) && existsSync(npmignorePath)) {
    try {
      copyFileSync(npmignorePath, gitignorePath);
      diag.layer2 = 'created from .npmignore';
    } catch (e) {
      diag.layer2Error = e instanceof Error ? e.message : String(e);
    }
  }

  // Layer 3: Last resort — write a sensible default
  if (!existsSync(gitignorePath)) {
    const defaultContent = [
      'node_modules/',
      'dist/',
      '.env',
      '.env.local',
      '.DS_Store',
      'Thumbs.db',
      '*.log',
      '.eliza/',
      '.elizadb/',
      'pglite/',
      'cache/',
      '',
    ].join('\n');
    try {
      writeFileSync(gitignorePath, defaultContent);
      diag.layer3 = `wrote default (${defaultContent.length} bytes)`;
    } catch (e) {
      diag.layer3Error = e instanceof Error ? e.message : String(e);
    }
  }

  diag.phase = 'done';
  diag.finalGitignoreExists = existsSync(gitignorePath);
  diag.finalNpmignoreExists = existsSync(npmignorePath);
  stderrLog(`DONE gitignore=${diag.finalGitignoreExists} npmignore=${diag.finalNpmignoreExists}`);

  // Clean up the diagnostic file so it doesn't ship in user projects.
  // The stderr logging above preserves CI traceability without leaving
  // artifacts containing internal paths in every generated project.
  try {
    if (existsSync(diagPath)) {
      unlinkSync(diagPath);
    }
  } catch {
    // best-effort — don't fail the template copy over cleanup
  }
  // --- END .gitignore pipeline ---

  // For plugin templates, replace hardcoded "plugin-starter" strings in source files
  if (templateType === 'plugin' || templateType === 'plugin-quick') {
    const pluginNameFromPath = path.basename(targetDir);
    await replacePluginNameInFiles(targetDir, pluginNameFromPath);
  }

  // Update package.json with dependency versions only (leave placeholders intact)
  const packageJsonPath = path.join(targetDir, 'package.json');

  try {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

    // Remove private field from template package.json since templates should be usable by users
    if (packageJson.private) {
      delete packageJson.private;
      logger.debug(
        { src: 'cli', util: 'copy-template' },
        'Removed private field from template package.json'
      );
    }

    // Normalize workspace references only; do not pin versions to CLI version
    const normalizeElizaDep = (currentVersion: string): string => {
      // Convert workspace:* or workspace:^ to public registry 'latest'
      if (typeof currentVersion === 'string' && currentVersion.startsWith('workspace:')) {
        return 'latest';
      }
      return currentVersion;
    };

    if (packageJson.dependencies) {
      for (const depName of Object.keys(packageJson.dependencies)) {
        if (depName.startsWith('@elizaos/')) {
          const before = packageJson.dependencies[depName];
          const after = normalizeElizaDep(before);
          if (after !== before) {
            if (!isQuietMode()) {
              logger.info(
                { src: 'cli', util: 'copy-template', depName, version: after },
                'Setting dependency version'
              );
            }
            packageJson.dependencies[depName] = after;
          }
        }
      }
    }

    if (packageJson.devDependencies) {
      for (const depName of Object.keys(packageJson.devDependencies)) {
        if (depName.startsWith('@elizaos/')) {
          const before = packageJson.devDependencies[depName];
          const after = normalizeElizaDep(before);
          if (after !== before) {
            if (!isQuietMode()) {
              logger.info(
                { src: 'cli', util: 'copy-template', depName, version: after },
                'Setting dev dependency version'
              );
            }
            packageJson.devDependencies[depName] = after;
          }
        }
      }
    }

    // Update the package name to use the actual name provided by the user
    const projectNameFromPath = path.basename(targetDir);

    if (packageJson.name !== projectNameFromPath) {
      packageJson.name = projectNameFromPath;
      if (!isQuietMode()) {
        logger.info(
          { src: 'cli', util: 'copy-template', packageName: projectNameFromPath },
          'Setting package name'
        );
      }
    }

    // Write the updated package.json (dependency versions and plugin name changed)
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
    logger.debug(
      { src: 'cli', util: 'copy-template' },
      'Updated package.json with latest dependency versions'
    );
  } catch (error) {
    logger.error(
      {
        src: 'cli',
        util: 'copy-template',
        error: error instanceof Error ? error.message : String(error),
      },
      'Error updating package.json'
    );
    throw error;
  }

  logger.debug({ src: 'cli', util: 'copy-template', templateType }, 'Template copied successfully');
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
        logger.debug(
          { src: 'cli', util: 'copy-template', filePath },
          'Updated plugin name in file'
        );
      }
    } catch (error) {
      logger.warn(
        {
          src: 'cli',
          util: 'copy-template',
          filePath,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not update file'
      );
    }
  });

  await Promise.all(promises);
}
