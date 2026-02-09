#!/usr/bin/env node

/**
 * Pre-build script: copies template packages from the monorepo into the CLI
 * templates directory so they are bundled with the CLI distribution.
 *
 * ## .gitignore / .npmignore handling — READ BEFORE MODIFYING
 *
 * These dotfiles require special care because they can be silently lost at
 * multiple stages of the pipeline:
 *
 *   1. **npm publish** strips `.gitignore` from packages and renames it to
 *      `.npmignore`.  Template source packages (e.g. `packages/project-starter`)
 *      therefore ship BOTH files in the git repo so that the template always has
 *      a `.gitignore` regardless of whether it was installed from npm or copied
 *      from the monorepo.
 *
 *   2. **fs-extra `copy()`** (used below) has been observed to silently skip
 *      `.gitignore` and `.npmignore` on certain Bun versions and Linux CI
 *      runners.  After copying, this script explicitly verifies the files exist
 *      and re-copies them individually if they were missed.
 *
 *   3. **`packages/cli/.gitignore`** contains `templates/` which means the
 *      generated `packages/cli/templates/` directory is not tracked by git.
 *      This is intentional — templates are regenerated at build time.
 *
 * Do NOT remove the explicit dotfile verification / fallback below without
 * also confirming that `.gitignore` appears in created projects on Ubuntu CI.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define paths
const ROOT_DIR = path.resolve(__dirname, '../../../..');
const TEMPLATES_DIR = path.resolve(ROOT_DIR, 'packages/cli/templates');

/**
 * Updates package.json with the CLI version and replaces workspace references
 */
async function updatePackageJson(packagePath: string, cliVersion: string) {
  const packageJsonContent = await fs.readFile(packagePath, 'utf-8');
  const packageData = JSON.parse(packageJsonContent);

  // Use a standard initial version for new packages
  packageData.version = '0.1.0';

  // Replace workspace references in dependencies
  for (const section of ['dependencies', 'devDependencies']) {
    if (packageData[section]) {
      for (const [dep, version] of Object.entries(packageData[section])) {
        if (version === 'workspace:*') {
          packageData[section][dep] = cliVersion;
        }
      }
    }
  }

  // Set repository URL for templates
  if (packageData.repository) {
    packageData.repository.url = '';
  }

  await fs.writeFile(packagePath, JSON.stringify(packageData, null, 2));
}

async function main() {
  try {
    // This script prepares templates in the source directory before the CLI is built
    // It copies from monorepo packages to packages/cli/templates/

    // Prepare templates directory
    if (!fs.existsSync(TEMPLATES_DIR)) {
      await fs.ensureDir(TEMPLATES_DIR);
    } else {
      // Clean existing templates to prevent conflicts
      await fs.emptyDir(TEMPLATES_DIR);
    }

    // Get CLI version from package.json
    const cliPackageJsonPath = path.resolve(ROOT_DIR, 'packages/cli/package.json');
    const cliPackageData = JSON.parse(await fs.readFile(cliPackageJsonPath, 'utf-8'));
    const cliVersion = cliPackageData.version;

    // Define templates to copy
    const templates = [
      {
        name: 'project-starter',
        src: path.resolve(ROOT_DIR, 'packages/project-starter'),
        dest: path.resolve(TEMPLATES_DIR, 'project-starter'),
      },
      {
        name: 'project-tee-starter',
        src: path.resolve(ROOT_DIR, 'packages/project-tee-starter'),
        dest: path.resolve(TEMPLATES_DIR, 'project-tee-starter'),
      },
      {
        name: 'plugin-starter',
        src: path.resolve(ROOT_DIR, 'packages/plugin-starter'),
        dest: path.resolve(TEMPLATES_DIR, 'plugin-starter'),
      },
      {
        name: 'plugin-quick-starter',
        src: path.resolve(ROOT_DIR, 'packages/plugin-quick-starter'),
        dest: path.resolve(TEMPLATES_DIR, 'plugin-quick-starter'),
      },
    ];

    // Copy each template and update its package.json
    for (const template of templates) {
      const srcGitignore = path.join(template.src, '.gitignore');
      const srcNpmignore = path.join(template.src, '.npmignore');
      console.log(`  [copy-tpl] ${template.name}: src .gitignore=${fs.existsSync(srcGitignore)}, .npmignore=${fs.existsSync(srcNpmignore)}`);

      await fs.copy(template.src, template.dest, {
        filter: (srcPath) => {
          const baseName = path.basename(srcPath);
          if (baseName === 'node_modules' || baseName === '.git') {
            return false;
          }
          return true;
        },
      });

      // Verify dotfiles were copied; fs-extra may skip .gitignore/.npmignore
      // on some platforms or Bun versions. Explicitly copy them as fallback.
      const destGitignore = path.join(template.dest, '.gitignore');
      const destNpmignore = path.join(template.dest, '.npmignore');
      const gitignoreCopied = fs.existsSync(destGitignore);
      const npmignoreCopied = fs.existsSync(destNpmignore);
      console.log(`  [copy-tpl] ${template.name}: dest .gitignore=${gitignoreCopied}, .npmignore=${npmignoreCopied}`);

      if (!gitignoreCopied && fs.existsSync(srcGitignore)) {
        console.log(`  [copy-tpl] ${template.name}: FIXING — fs.copy missed .gitignore, copying explicitly`);
        await fs.copyFile(srcGitignore, destGitignore);
      }
      if (!npmignoreCopied && fs.existsSync(srcNpmignore)) {
        console.log(`  [copy-tpl] ${template.name}: FIXING — fs.copy missed .npmignore, copying explicitly`);
        await fs.copyFile(srcNpmignore, destNpmignore);
      }

      // If source has no .gitignore at all, create a default one
      if (!fs.existsSync(destGitignore)) {
        console.log(`  [copy-tpl] ${template.name}: creating default .gitignore`);
        await fs.writeFile(destGitignore, [
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
        ].join('\n'));
      }

      // Update package.json with correct version
      const packageJsonPath = path.resolve(template.dest, 'package.json');
      await updatePackageJson(packageJsonPath, cliVersion);
    }

    console.log('Templates have been copied and updated successfully.');
  } catch (error) {
    console.error('Error copying templates:', error);
    process.exit(1);
  }
}

main();
