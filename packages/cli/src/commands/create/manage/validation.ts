import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import * as clack from '@clack/prompts';
import { z } from 'zod';
import type { CreateOptions } from '../types';
import { initOptionsSchema } from '../types';

/**
 * Project name validation schema
 */
export const ProjectNameSchema = z.string()
  .min(1, 'Project name cannot be empty')
  .regex(/^[a-z0-9-_]+$/, 'Project name must contain only lowercase letters, numbers, hyphens, and underscores')
  .refine(name => !name.startsWith('-') && !name.endsWith('-'), 'Project name cannot start or end with a hyphen')
  .refine(name => !name.startsWith('_') && !name.endsWith('_'), 'Project name cannot start or end with an underscore');

/**
 * Plugin name validation schema
 */
export const PluginNameSchema = z.string()
  .min(1, 'Plugin name cannot be empty')
  .regex(/^[a-z0-9-_]+$/, 'Plugin name must contain only lowercase letters, numbers, hyphens, and underscores')
  .refine(name => !name.startsWith('-') && !name.endsWith('-'), 'Plugin name cannot start or end with a hyphen')
  .refine(name => !name.startsWith('_') && !name.endsWith('_'), 'Plugin name cannot start or end with an underscore');

/**
 * Validates create command options using Zod schema
 */
export function validateCreateOptions(options: any): CreateOptions {
  return initOptionsSchema.parse(options);
}

/**
 * Validates a project name according to npm package naming rules.
 */
export function validateProjectName(name: string): { isValid: boolean; error?: string } {
  try {
    ProjectNameSchema.parse(name);
    return { isValid: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { isValid: false, error: error.errors[0].message };
    }
    return { isValid: false, error: 'Invalid project name' };
  }
}

/**
 * Processes and validates a plugin name.
 */
export function processPluginName(name: string): { isValid: boolean; processedName?: string; error?: string } {
  try {
    // Remove common prefixes and suffixes
    let processedName = name
      .replace(/^(eliza-?|elizaos-?|plugin-?)/i, '')
      .replace(/(-?plugin|-?eliza|-?elizaos)$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');

    if (!processedName) {
      return { isValid: false, error: 'Plugin name cannot be empty after processing' };
    }

    PluginNameSchema.parse(processedName);
    return { isValid: true, processedName };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { isValid: false, error: error.errors[0].message };
    }
    return { isValid: false, error: 'Invalid plugin name' };
  }
}

/**
 * Validates that the target directory is empty or doesn't exist.
 */
export async function validateTargetDirectory(targetDir: string): Promise<{ isValid: boolean; error?: string }> {
  try {
    if (!existsSync(targetDir)) {
      return { isValid: true };
    }

    const entries = await fs.readdir(targetDir);
    if (entries.length > 0) {
      return { 
        isValid: false, 
        error: `Directory ${targetDir} is not empty. Please choose an empty directory or a new name.` 
      };
    }

    return { isValid: true };
  } catch (error) {
    return { 
      isValid: false, 
      error: `Failed to validate directory: ${error instanceof Error ? error.message : 'Unknown error'}` 
    };
  }
}