#!/usr/bin/env node

/**
 * This script copies the built CLI files into the create-eliza package
 * It should be run as part of the CLI build process
 */

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define paths
const ROOT_DIR = path.resolve(__dirname, '../../../..');
const CLI_DIST_DIR = path.resolve(ROOT_DIR, 'packages/cli/dist');
const TARGET_DIR = path.resolve(ROOT_DIR, 'packages/create-eliza/cli');

async function main() {
  try {
    // Ensure the CLI is built
    console.log('Checking if CLI is built...');
    if (!fs.existsSync(CLI_DIST_DIR)) {
      console.error('CLI build not found! Build the CLI first.');
      process.exit(1);
    }

    // Ensure target directory exists
    console.log('Creating target directory...');
    await fs.ensureDir(TARGET_DIR);

    // Copy CLI build files to create-eliza
    console.log('Copying CLI files to create-eliza package...');
    await fs.copy(CLI_DIST_DIR, TARGET_DIR, {
      overwrite: true,
      errorOnExist: false
    });

    console.log('CLI files successfully copied to create-eliza package.');
  } catch (error) {
    console.error('Error copying CLI to create-eliza:', error);
    process.exit(1);
  }
}

main(); 