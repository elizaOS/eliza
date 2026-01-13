/**
 * Configuration utilities
 * Converted from sweagent/utils/config.py
 */

import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import * as yaml from 'js-yaml';

/**
 * Convert path relative to repository root
 */
export function convertPathRelativeToRepoRoot(
  inputPath: string | path.ParsedPath,
  root?: string,
): string | path.ParsedPath {
  if (typeof inputPath === 'string' && inputPath.startsWith('/')) {
    return inputPath;
  }
  const rootPath = root || process.cwd();
  return typeof inputPath === 'string'
    ? path.resolve(rootPath, inputPath)
    : path.parse(path.resolve(rootPath, path.format(inputPath)));
}

/**
 * Check if a value could be a path
 */
export function couldBeAPath(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  return value.includes('/') || value.includes('\\') || value.includes('.');
}

/**
 * Strip absolute paths from dictionary
 */
export function stripAbspathFromDict(value: unknown, root?: string): unknown {
  if (typeof value === 'string') {
    const rootPath = root || process.cwd();
    if (value.startsWith(rootPath)) {
      return path.relative(rootPath, value);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((v) => stripAbspathFromDict(v, root));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = stripAbspathFromDict(v, root);
    }
    return result;
  }

  return value;
}

/**
 * Convert path to absolute path
 */
export function convertPathToAbspath(inputPath: string | path.ParsedPath): path.ParsedPath {
  if (typeof inputPath === 'string') {
    // Check for SWE_AGENT_CONFIG_ROOT environment variable
    const configRoot = process.env.SWE_AGENT_CONFIG_ROOT;
    if (configRoot && !path.isAbsolute(inputPath)) {
      return path.parse(path.resolve(configRoot, inputPath));
    }
    return path.parse(path.resolve(inputPath));
  }
  return inputPath;
}

/**
 * Convert paths array to absolute paths
 */
export function convertPathsToAbspath(paths: Array<string | path.ParsedPath>): path.ParsedPath[] {
  return paths.map((p) => convertPathToAbspath(p));
}

/**
 * Load environment variables from .env file
 */
export function loadEnvironmentVariables(envPath?: string): void {
  if (envPath && fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else {
    dotenv.config();
  }
}

/**
 * Parse config file content
 */
export function parseConfigFile(content: string, format: 'yaml' | 'json'): any {
  if (format === 'yaml') {
    return yaml.load(content);
  } else if (format === 'json') {
    return JSON.parse(content);
  } else {
    throw new Error(`Unsupported format: ${format}`);
  }
}

/**
 * Merge two config objects deeply
 */
export function mergeConfigs(baseConfig: any, overrideConfig: any): any {
  const result = { ...baseConfig };

  for (const key in overrideConfig) {
    if (overrideConfig.hasOwnProperty(key)) {
      if (
        typeof overrideConfig[key] === 'object' &&
        overrideConfig[key] !== null &&
        !Array.isArray(overrideConfig[key]) &&
        typeof baseConfig[key] === 'object' &&
        baseConfig[key] !== null &&
        !Array.isArray(baseConfig[key])
      ) {
        // Recursively merge nested objects
        result[key] = mergeConfigs(baseConfig[key], overrideConfig[key]);
      } else {
        // Replace value
        result[key] = overrideConfig[key];
      }
    }
  }

  return result;
}

/**
 * Validate config structure
 */
export function validateConfig(config: any): void {
  if (!config || typeof config !== 'object') {
    throw new Error('Config must be an object');
  }

  if (config.agent && typeof config.agent !== 'object') {
    throw new Error('Config agent property must be an object');
  }

  // Add more validation as needed
}
