#!/usr/bin/env node

/**
 * This script copies the built CLI files into the create-eliza package
 * It should be run as part of the CLI build process
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
async function updatePackageJson(packagePath, cliVersion) {
  const packageJsonContent = await fs.readFile(packagePath, 'utf-8');
  const packageData = JSON.parse(packageJsonContent);

  // Update version
  packageData.version = cliVersion;

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

  await fs.writeFile(packagePath, JSON.stringify(packageData, null, 2));
}

async function main() {
  try {
    // Ensure the CLI is built
    console.log('Checking if CLI is built...');
    if (!fs.existsSync(CLI_DIST_DIR)) {
      console.error('CLI build not found! Build the CLI first.');
      process.exit(1);
    }

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
    console.log('CLI version:', cliVersion);

    // Define templates to copy
    const templates = [
      {
        name: 'project-starter',
        src: path.resolve(ROOT_DIR, 'packages/project-starter'),
        dest: path.resolve(TEMPLATES_DIR, 'project-starter'),
      },
      {
        name: 'plugin-starter',
        src: path.resolve(ROOT_DIR, 'packages/plugin-starter'),
        dest: path.resolve(TEMPLATES_DIR, 'plugin-starter'),
      },
    ];

    // Copy each template and update its package.json
    for (const template of templates) {
      console.log(`Copying from ${template.src} to ${template.dest}`);
      await fs.copy(template.src, template.dest);

      // Update package.json with correct version
      const packageJsonPath = path.resolve(template.dest, 'package.json');
      await updatePackageJson(packageJsonPath, cliVersion);
    }

    console.log('Templates successfully copied to packages/cli/templates.');
  } catch (error) {
    console.error('Error copying templates:', error);
    process.exit(1);
  }
}

main();
