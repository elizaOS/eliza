#!/usr/bin/env node

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

async function build() {
  console.log('Building Vision Plugin...\n');

  try {
    // Clean dist directory
    console.log('1. Cleaning dist directory...');
    const distPath = path.join(rootDir, 'dist');
    await fs.rm(distPath, { recursive: true, force: true });
    await fs.mkdir(distPath, { recursive: true });

    // Compile TypeScript
    console.log('2. Compiling TypeScript...');
    const { stdout, stderr } = await execAsync('npx tsc --project tsconfig.build.json', {
      cwd: rootDir,
    });

    if (stderr) {
      console.error('TypeScript compilation warnings:', stderr);
    }

    // Copy non-TS files
    console.log('3. Copying assets...');
    const modelsPath = path.join(rootDir, 'models');
    const distModelsPath = path.join(distPath, 'models');

    try {
      await fs.cp(modelsPath, distModelsPath, { recursive: true });
      console.log('   ✓ Copied models directory');
    } catch (err) {
      console.log('   ℹ Models directory not found, skipping');
    }

    // Create package.json for dist
    console.log('4. Creating dist package.json...');
    const pkgJson = JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf-8'));
    const distPkgJson = {
      name: pkgJson.name,
      version: pkgJson.version,
      description: pkgJson.description,
      main: 'index.js',
      types: 'index.d.ts',
      dependencies: pkgJson.dependencies,
      peerDependencies: pkgJson.peerDependencies,
    };
    await fs.writeFile(path.join(distPath, 'package.json'), JSON.stringify(distPkgJson, null, 2));

    console.log('\n✅ Build complete!');
    console.log(`   Output: ${distPath}`);
  } catch (error) {
    console.error('\n❌ Build failed:', error.message);
    process.exit(1);
  }
}

// Run build
build().catch(console.error);
