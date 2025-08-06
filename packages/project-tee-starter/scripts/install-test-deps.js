#!/usr/bin/env bun

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const testDependencies = {
  // Cypress dependencies removed - using bun test instead
};

function isInstalled(packageName) {
  try {
    const packageJsonPath = join(process.cwd(), 'package.json');
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      return packageName in deps;
    }
  } catch (error) {
    // Silent fail, will install if error
  }
  return false;
}

function installTestDependencies() {
  const missingDeps = Object.entries(testDependencies)
    .filter(([name]) => !isInstalled(name))
    .map(([name, version]) => `${name}@${version}`);

  if (missingDeps.length === 0) {
    console.log('✓ Test dependencies already installed');
    return;
  }

  console.log('Installing test dependencies...');
  try {
    const proc = Bun.spawnSync(['bun', 'add', '-d', ...missingDeps], {
      stdout: 'inherit',
      stderr: 'inherit',
      cwd: process.cwd(),
    });

    if (proc.exitCode !== 0) {
      throw new Error('bun add command failed');
    }
    console.log('✓ Test dependencies installed successfully');
  } catch (error) {
    console.error('Failed to install test dependencies:', error.message);
    process.exit(1);
  }
}

installTestDependencies();
