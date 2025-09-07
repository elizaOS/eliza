#!/usr/bin/env node

/**
 * This script copies template packages from the monorepo into the CLI templates directory
 * It runs before the CLI build to prepare templates that will be included in the distribution
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define paths
const ROOT_DIR = path.resolve(__dirname, '../../../..');
const CLI_DIST_DIR = path.resolve(ROOT_DIR, 'packages/cli/dist');
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
      await fs.copy(template.src, template.dest, {
        filter: (srcPath) => {
          const baseName = path.basename(srcPath);
          if (baseName === 'node_modules' || baseName === '.git') {
            // console.log(`Filtering out: ${srcPath}`); // Log which paths are being filtered
            return false;
          }
          return true;
        },
      });

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
