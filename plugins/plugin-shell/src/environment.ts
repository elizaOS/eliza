import { logger } from '@elizaos/core';
import joi from 'joi';
import path from 'path';
import fs from 'fs';

/**
 * Shell plugin environment configuration
 */
export interface ShellConfig {
  enabled: boolean;
  allowedDirectory: string;
  timeout: number;
  forbiddenCommands: string[];
}

// Environment validation schema
const configSchema = joi.object({
  enabled: joi.boolean().required(),
  allowedDirectory: joi.string().when('enabled', {
    is: true,
    then: joi.required(),
    otherwise: joi.optional(),
  }),
  timeout: joi.number().positive().default(30000),
  forbiddenCommands: joi.array().items(joi.string()).required(),
});

/**
 * Default forbidden commands for safety
 */
const DEFAULT_FORBIDDEN_COMMANDS = [
  'rm -rf /',  // Only block dangerous rm commands, not all rm
  'rmdir',
  'chmod 777',  // Only block dangerous chmod, not all chmod
  'chown',
  'chgrp',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'kill -9',  // Only block force kill, not all kill
  'killall',
  'pkill',
  'sudo rm -rf',  // Block dangerous sudo commands
  'su',
  'passwd',
  'useradd',
  'userdel',
  'groupadd',
  'groupdel',
  'format',
  'fdisk',
  'mkfs',
  'dd if=/dev/zero',  // Only block dangerous dd
  'shred',
  ':(){:|:&};:',  // Fork bomb
];

/**
 * Loads and validates the shell plugin configuration
 * @returns The validated configuration
 */
export function loadShellConfig(): ShellConfig {
  const enabled = process.env.SHELL_ENABLED === 'true';
  const allowedDirectory = process.env.SHELL_ALLOWED_DIRECTORY || process.cwd();
  const timeout = parseInt(process.env.SHELL_TIMEOUT || '30000', 10);
  
  // Parse forbidden commands
  const customForbidden = process.env.SHELL_FORBIDDEN_COMMANDS
    ? process.env.SHELL_FORBIDDEN_COMMANDS.split(',').map((cmd) => cmd.trim())
    : [];
  
  // Combine default and custom forbidden commands
  const forbiddenCommands = [...new Set([...DEFAULT_FORBIDDEN_COMMANDS, ...customForbidden])];

  const config: ShellConfig = {
    enabled,
    allowedDirectory,
    timeout,
    forbiddenCommands,
  };

  // Validate configuration
  const { error, value } = configSchema.validate(config);
  if (error) {
    throw new Error(`Shell plugin configuration error: ${error.message}`);
  }

  // Additional validation for allowed directory
  if (enabled && allowedDirectory) {
    try {
      // Check if directory exists
      const stats = fs.statSync(allowedDirectory);
      if (!stats.isDirectory()) {
        throw new Error(`SHELL_ALLOWED_DIRECTORY is not a directory: ${allowedDirectory}`);
      }
      
      // Resolve to absolute path
      value.allowedDirectory = path.resolve(allowedDirectory);
      
      logger.info(`Shell plugin enabled with allowed directory: ${value.allowedDirectory}`);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error(`SHELL_ALLOWED_DIRECTORY does not exist: ${allowedDirectory}`);
      }
      throw error;
    }
  }

  if (!enabled) {
    logger.info('Shell plugin is disabled. Set SHELL_ENABLED=true to enable.');
  }

  return value as ShellConfig;
} 