#!/usr/bin/env bun

/**
 * Generate version.ts file at build time with CLI package information
 * This eliminates the need to read package.json at runtime
 *
 * NOTE: This script is smart about updates - it only rewrites the file if the
 * version, name, or description have changed. This prevents unnecessary file
 * modifications that could trigger watch mode rebuild loops.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface VersionInfo {
  version: string;
  name: string;
  description: string;
}

/**
 * Extract version info from existing version.ts content
 * Uses regex that properly handles JSON-stringified values (double quotes, escaped chars)
 */
function extractExistingVersionInfo(content: string): VersionInfo | null {
  // Regex pattern for JSON-stringified strings: "(...)"
  // (?:[^"\\]|\\.)* matches: non-quote/non-backslash chars OR any escaped char (like \", \\, \n)
  // This handles apostrophes, escaped quotes, and other special characters
  const jsonStringPattern = (name: string) =>
    new RegExp(`export const ${name} = "((?:[^"\\\\]|\\\\.)*)"`);

  const version = content.match(jsonStringPattern('CLI_VERSION'))?.[1];
  const name = content.match(jsonStringPattern('CLI_NAME'))?.[1];
  const description = content.match(jsonStringPattern('CLI_DESCRIPTION'))?.[1];

  if (!version || !name || !description) {
    return null;
  }

  return { version, name, description };
}

/**
 * Check if version info matches the existing file content
 */
function versionInfoMatches(existingContent: string, newInfo: VersionInfo): boolean {
  const existingInfo = extractExistingVersionInfo(existingContent);
  if (!existingInfo) {
    return false;
  }
  return (
    existingInfo.version === newInfo.version &&
    existingInfo.name === newInfo.name &&
    existingInfo.description === newInfo.description
  );
}

/**
 * Safely read a file, returning null if it doesn't exist
 */
async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

async function generateVersionFile(): Promise<void> {
  try {
    // Read the CLI package.json
    const packageJsonPath = path.resolve(__dirname, '../../package.json');
    const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);

    // Extract version info with defaults
    const versionInfo: VersionInfo = {
      version: packageJson.version || '0.0.0',
      name: packageJson.name || '@elizaos/cli',
      description: packageJson.description || 'elizaOS CLI',
    };

    const outputPath = path.resolve(__dirname, '../version.ts');

    // Check if version.ts already exists and has the same version info
    // This prevents unnecessary file writes that trigger watch mode rebuild loops
    const existingContent = await readFileOrNull(outputPath);
    if (existingContent && versionInfoMatches(existingContent, versionInfo)) {
      console.log(`✓ version.ts is up to date (CLI version ${versionInfo.version})`);
      return;
    }

    // Generate the TypeScript content
    // Note: BUILD_TIME is intentionally not used for comparison since it always changes
    // Use JSON.stringify for safe escaping of special characters (quotes, backslashes, etc.)
    const content = `/**
 * Auto-generated file - DO NOT EDIT
 * Generated at build time by generate-version.ts
 * This file contains build-time constants to avoid runtime package.json resolution
 */

export const CLI_VERSION = ${JSON.stringify(versionInfo.version)};
export const CLI_NAME = ${JSON.stringify(versionInfo.name)};
export const CLI_DESCRIPTION = ${JSON.stringify(versionInfo.description)};

// Build metadata
export const BUILD_TIME = ${JSON.stringify(new Date().toISOString())};
export const BUILD_ENV = ${JSON.stringify(process.env.NODE_ENV || 'production')};

// Export as default for convenience
export default {
  version: CLI_VERSION,
  name: CLI_NAME,
  description: CLI_DESCRIPTION,
  buildTime: BUILD_TIME,
  buildEnv: BUILD_ENV,
};
`;

    await fs.writeFile(outputPath, content, 'utf-8');
    console.log(`✓ Generated version.ts with CLI version ${versionInfo.version}`);
  } catch (error) {
    console.error('Failed to generate version.ts:', error);
    process.exit(1);
  }
}

// Run the generator
generateVersionFile();
