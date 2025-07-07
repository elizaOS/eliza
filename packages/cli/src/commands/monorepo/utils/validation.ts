import { MonorepoOptions } from '../types';

/**
 * Validates monorepo command options
 */
export function validateMonorepoOptions(options: Partial<MonorepoOptions>): MonorepoOptions {
  // Check for empty branch
  if (options.branch === '') {
    throw new Error('Branch name cannot be empty. Usage: elizaos monorepo --branch <branch-name>');
  }
  
  // Check for empty directory
  if (options.dir === '') {
    throw new Error('Directory name cannot be empty. Usage: elizaos monorepo --dir <directory-name>');
  }
  
  // Return validated options with defaults
  return {
    branch: options.branch || 'develop',
    dir: options.dir || './eliza',
  };
} 