#!/usr/bin/env bun

/**
 * Generate version.ts file at build time with CLI package information
 * This eliminates the need to read package.json at runtime
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function generateVersionFile() {
  try {
    // Read the CLI package.json
    const packageJsonPath = path.resolve(__dirname, '../../package.json');
    const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);

    // Extract version and name
    const version = packageJson.version || '0.0.0';
    const name = packageJson.name || '@elizaos/cli';
    const description = packageJson.description || 'elizaOS CLI';

    // Generate the TypeScript content
    const content = `/**
 * Auto-generated file - DO NOT EDIT
 * Generated at build time by generate-version.ts
 * This file contains build-time constants to avoid runtime package.json resolution
 */

export const CLI_VERSION = '${version}';
export const CLI_NAME = '${name}';
export const CLI_DESCRIPTION = '${description}';

// Build metadata
export const BUILD_TIME = '${new Date().toISOString()}';
export const BUILD_ENV = '${process.env.NODE_ENV || 'production'}';

// Export as default for convenience
export default {
  version: CLI_VERSION,
  name: CLI_NAME,
  description: CLI_DESCRIPTION,
  buildTime: BUILD_TIME,
  buildEnv: BUILD_ENV,
};
`;

    // Write the generated file
    const outputPath = path.resolve(__dirname, '../version.ts');
    await fs.writeFile(outputPath, content, 'utf-8');

    console.log(`✓ Generated version.ts with CLI version ${version}`);
  } catch (error) {
    console.error('Failed to generate version.ts:', error);
    process.exit(1);
  }
}

// Run the generator
generateVersionFile();
