#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define paths
const ROOT_DIR = path.resolve(__dirname, '../../../..');
const CLI_DIR = path.resolve(ROOT_DIR, 'packages/cli/drizzle');
const DRIZZLE_DIR = path.resolve(ROOT_DIR, 'packages/plugin-sql/drizzle');

async function main() {
  try {
    // create the drizzle directory if it doesn't exist
    await fs.ensureDir(CLI_DIR);

    await fs.copy(DRIZZLE_DIR, CLI_DIR);

    console.log('Drizzle successfully copied to packages/cli');
  } catch (error) {
    console.error('Error copying templates:', error);
    process.exit(1);
  }
}

main();
