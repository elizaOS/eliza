import path from 'path';
import { logger } from '@elizaos/core';

/**
 * Normalizes a path and ensures it's within the allowed directory
 * @param commandPath The path from the command
 * @param allowedDir The allowed directory
 * @param currentDir The current working directory
 * @returns The normalized absolute path or null if invalid
 */
export function validatePath(
  commandPath: string,
  allowedDir: string,
  currentDir: string
): string | null {
  try {
    // Resolve the path relative to current directory
    const resolvedPath = path.resolve(currentDir, commandPath);
    const normalizedPath = path.normalize(resolvedPath);
    const normalizedAllowed = path.normalize(allowedDir);

    // Check if the resolved path is within the allowed directory
    if (!normalizedPath.startsWith(normalizedAllowed)) {
      logger.warn(
        `Path validation failed: ${normalizedPath} is outside allowed directory ${normalizedAllowed}`
      );
      return null;
    }

    return normalizedPath;
  } catch (error) {
    logger.error('Error validating path:', error);
    return null;
  }
}

/**
 * Checks if a command contains path traversal attempts or dangerous patterns
 * @param command The command to check
 * @returns true if the command appears safe, false if it contains dangerous patterns
 */
export function isSafeCommand(command: string): boolean {
  // Check for path traversal patterns
  const pathTraversalPatterns = [
    /\.\.\//g,           // ../
    /\.\.\\/g,           // ..\
    /\/\.\./g,           // /..
    /\\\.\./g,           // \..
  ];

  // Check for dangerous command patterns (but allow safe file operations)
  const dangerousPatterns = [
    /\$\(/g,             // Command substitution $(
    /`[^']*`/g,          // Command substitution ` (but allow in quotes)
    /\|\s*sudo/g,        // Pipe to sudo
    /;\s*sudo/g,         // Chain with sudo
    /&\s*&/g,            // && chaining
    /\|\s*\|/g,          // || chaining
  ];

  // First check for path traversal
  for (const pattern of pathTraversalPatterns) {
    if (pattern.test(command)) {
      logger.warn(`Path traversal detected in command: ${command}`);
      return false;
    }
  }

  // Then check for dangerous command patterns
  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      logger.warn(`Dangerous pattern detected in command: ${command}`);
      return false;
    }
  }

  // Allow single pipes and redirects for file operations
  // but block multiple pipes or complex chains
  const pipeCount = (command.match(/\|/g) || []).length;
  if (pipeCount > 1) {
    logger.warn(`Multiple pipes detected in command: ${command}`);
    return false;
  }

  return true;
}

/**
 * Extracts the base command from a full command string
 * @param fullCommand The full command string
 * @returns The base command
 */
export function extractBaseCommand(fullCommand: string): string {
  // Split by space and get the first part
  const parts = fullCommand.trim().split(/\s+/);
  return parts[0] || '';
}

/**
 * Checks if a command is in the forbidden list
 * @param command The command to check
 * @param forbiddenCommands List of forbidden commands/patterns
 * @returns true if the command is forbidden
 */
export function isForbiddenCommand(
  command: string,
  forbiddenCommands: string[]
): boolean {
  const normalizedCommand = command.trim().toLowerCase();
  
  // Check each forbidden pattern
  return forbiddenCommands.some((forbidden) => {
    const forbiddenLower = forbidden.toLowerCase();
    
    // Check if the command starts with the forbidden pattern
    if (normalizedCommand.startsWith(forbiddenLower)) {
      return true;
    }
    
    // Also check if it's the exact base command for single-word forbidden commands
    if (!forbidden.includes(' ')) {
      const baseCommand = extractBaseCommand(command);
      if (baseCommand.toLowerCase() === forbiddenLower) {
        return true;
      }
    }
    
    return false;
  });
} 