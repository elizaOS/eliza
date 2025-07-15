#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../..');
const templatesDir = path.resolve(__dirname, '../templates');

/**
 * Copy a directory recursively, excluding specified directories
 */
async function copyDir(src, dest, exclude = []) {
  // Create destination directory if it doesn't exist
  await fs.mkdir(dest, { recursive: true });

  // Read source directory
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip excluded directories/files
    if (exclude.includes(entry.name)) {
      continue;
    }

    // Skip node_modules, dist directories and .git directories
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === '.git' ||
      entry.name === 'cache' ||
      entry.name === 'data' ||
      entry.name === 'generatedImages' ||
      entry.name === '.turbo'
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      // Recursively copy directory
      await copyDir(srcPath, destPath, exclude);
    } else {
      // Copy file
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function copyTemplates() {
  console.log('Copying templates to CLI package...');

  // Ensure templates directory exists
  await fs.mkdir(templatesDir, { recursive: true });

  // Copy project-starter template
  const projectStarterSrc = path.join(rootDir, 'packages/project-starter');
  const projectStarterDest = path.join(templatesDir, 'project-starter');
  await copyDir(projectStarterSrc, projectStarterDest);
  console.log('✅ Copied project-starter template');

  // Copy project-tee-starter template
  const projectTeeStarterSrc = path.join(rootDir, 'packages/project-tee-starter');
  const projectTeeStarterDest = path.join(templatesDir, 'project-tee-starter');
  await copyDir(projectTeeStarterSrc, projectTeeStarterDest);
  console.log('✅ Copied project-tee-starter template');

  // Copy plugin-starter template
  const pluginStarterSrc = path.join(rootDir, 'packages/plugin-starter');
  const pluginStarterDest = path.join(templatesDir, 'plugin-starter');
  await copyDir(pluginStarterSrc, pluginStarterDest);
  console.log('✅ Copied plugin-starter template');

  // Copy plugin-quick-starter template
  const pluginQuickStarterSrc = path.join(rootDir, 'packages/plugin-quick-starter');
  const pluginQuickStarterDest = path.join(templatesDir, 'plugin-quick-starter');
  await copyDir(pluginQuickStarterSrc, pluginQuickStarterDest);
  console.log('✅ Copied plugin-quick-starter template');

  console.log('✅ All templates copied successfully!');
}

// Run the script
copyTemplates().catch((err) => {
  console.error('Error copying templates:', err);
  process.exit(1);
});
