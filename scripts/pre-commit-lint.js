#!/usr/bin/env node

import { existsSync } from 'node:fs';

// Log that we're starting
console.log('Running pre-commit hook...');

try {
  // Get all staged files using git diff --staged instead
  console.log('Checking for staged files...');
  const proc = Bun.spawnSync(['git', 'diff', '--staged', '--name-only'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (proc.exitCode !== 0) {
    throw new Error('Failed to get staged files');
  }

  const stagedFiles = new TextDecoder().decode(proc.stdout).trim().split('\n').filter(Boolean);

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
  const prettierProc = Bun.spawnSync(['bun', 'prettier', '--write', ...filesToLint], {
    stdout: 'inherit',
    stderr: 'inherit',
  });

  if (prettierProc.exitCode !== 0) {
    throw new Error('Prettier formatting failed');
  }

  // Add the formatted files back to staging
  const gitAddProc = Bun.spawnSync(['git', 'add', ...filesToLint], {
    stdout: 'inherit',
    stderr: 'inherit',
  });

  if (gitAddProc.exitCode !== 0) {
    throw new Error('Failed to add files to git');
  }

  console.log('Pre-commit linting completed successfully');
  process.exit(0);
} catch (error) {
  console.error('Error during pre-commit linting:', error.message);
  process.exit(1);
}
