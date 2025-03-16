#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Log that we're starting
console.log('Running pre-commit hook...');

try {
  // Get all staged files using git diff --staged instead
  console.log('Checking for staged files...');
  const stagedFiles = execSync('git diff --staged --name-only')
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean);

  console.log(`Found ${stagedFiles.length} staged files.`);

  if (stagedFiles.length === 0) {
    console.log('No staged files to lint');
    process.exit(0);
  }

  // Filter for files we want to process and check that they exist
  const filesToLint = stagedFiles.filter((file) => {
    const extensions = ['.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.md'];
    // Only include files that have valid extensions AND still exist (not deleted)
    return extensions.some((ext) => file.endsWith(ext)) && existsSync(file);
  });

  console.log(`Found ${filesToLint.length} files to format: ${filesToLint.join(', ')}`);

  if (filesToLint.length === 0) {
    console.log('No matching files to lint');
    process.exit(0);
  }

  // Run prettier on the files
  console.log('Running prettier on staged files...');
  const fileList = filesToLint.join(' ');
  execSync(`bun prettier --write ${fileList}`, { stdio: 'inherit' });

  // Add the formatted files back to staging
  execSync(`git add ${fileList}`, { stdio: 'inherit' });

  console.log('Pre-commit linting completed successfully');
  process.exit(0);
} catch (error) {
  console.error('Error during pre-commit linting:', error.message);
  process.exit(1);
}
