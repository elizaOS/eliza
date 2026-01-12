import path from "node:path";
import { logger } from "@elizaos/core";

export function validatePath(
  commandPath: string,
  allowedDir: string,
  currentDir: string
): string | null {
  const resolvedPath = path.resolve(currentDir, commandPath);
  const normalizedPath = path.normalize(resolvedPath);
  const normalizedAllowed = path.normalize(allowedDir);

  if (!normalizedPath.startsWith(normalizedAllowed)) {
    logger.warn(
      `Path validation failed: ${normalizedPath} is outside allowed directory ${normalizedAllowed}`
    );
    return null;
  }

  return normalizedPath;
}

export function isSafeCommand(command: string): boolean {
  const pathTraversalPatterns = [/\.\.\//g, /\.\.\\/g, /\/\.\./g, /\\\.\./g];

  const dangerousPatterns = [/\$\(/g, /`[^']*`/g, /\|\s*sudo/g, /;\s*sudo/g, /&\s*&/g, /\|\s*\|/g];

  for (const pattern of pathTraversalPatterns) {
    if (pattern.test(command)) {
      logger.warn(`Path traversal detected in command: ${command}`);
      return false;
    }
  }

  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      logger.warn(`Dangerous pattern detected in command: ${command}`);
      return false;
    }
  }

  const pipeCount = (command.match(/\|/g) || []).length;
  if (pipeCount > 1) {
    logger.warn(`Multiple pipes detected in command: ${command}`);
    return false;
  }

  return true;
}

export function extractBaseCommand(fullCommand: string): string {
  const parts = fullCommand.trim().split(/\s+/);
  return parts[0] || "";
}

export function isForbiddenCommand(command: string, forbiddenCommands: string[]): boolean {
  const normalizedCommand = command.trim().toLowerCase();

  return forbiddenCommands.some((forbidden) => {
    const forbiddenLower = forbidden.toLowerCase();

    if (normalizedCommand.startsWith(forbiddenLower)) {
      return true;
    }

    if (!forbidden.includes(" ")) {
      const baseCommand = extractBaseCommand(command);
      if (baseCommand.toLowerCase() === forbiddenLower) {
        return true;
      }
    }

    return false;
  });
}
