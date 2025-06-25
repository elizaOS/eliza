/**
 * Character Finder Utility
 * 
 * This utility handles finding and identifying character files in various locations,
 * resolving paths, and validating character file structures.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@elizaos/core';
import { globbySync } from 'globby';

/**
 * Resolve a character file path by checking common locations
 * Searches for character files in standard directories and handles
 * various naming conventions (.json extension optional)
 * 
 * @param characterPath - The character path to resolve (can be name, relative, or absolute path)
 * @returns Resolved absolute path if found, null otherwise
 */
export function resolveCharacterPath(characterPath: string): string | null {
  // If it's already an absolute path that exists, return it
  if (path.isAbsolute(characterPath) && fs.existsSync(characterPath)) {
    return characterPath;
  }

  // Add .json extension if not present
  const pathsToTry = [];
  if (characterPath.endsWith('.json')) {
    pathsToTry.push(characterPath);
    pathsToTry.push(characterPath.replace('.json', '.ts'));
  } else {
    pathsToTry.push(`${characterPath}.json`);
    pathsToTry.push(`${characterPath}.ts`);
    pathsToTry.push(characterPath);
  }

  // Common directories to check
  const baseDirs = [
    process.cwd(),
    path.join(process.cwd(), 'characters'),
    path.join(process.cwd(), 'agents'),
    path.join(process.cwd(), 'src', 'characters'),
    path.join(process.cwd(), 'src', 'agents'),
  ];

  // Try each combination
  for (const baseDir of baseDirs) {
    for (const pathToTry of pathsToTry) {
      const fullPath = path.join(baseDir, pathToTry);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  // If not found in common directories, search all directories
  const allCharacterFiles = findAllCharacterFiles(process.cwd());
  
  // Try to match by filename
  const fileName = path.basename(characterPath);
  for (const file of allCharacterFiles) {
    const baseName = path.basename(file, path.extname(file));
    const fileNameWithoutExt = fileName.replace(/\.(json|ts)$/, '');
    
    if (baseName === fileNameWithoutExt || path.basename(file) === fileName) {
      return file;
    }
  }

  return null;
}

/**
 * Find all potential character files in a directory tree
 * Searches for .json and .ts files recursively
 * 
 * @param directory - The root directory to search in
 * @returns Array of absolute file paths
 */
export function findAllCharacterFiles(directory: string): string[] {
  try {
    // Use globby to find all .json and .ts files recursively
    const files = globbySync(['**/*.json', '**/*.ts'], {
      cwd: directory,
      absolute: true,
      ignore: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/.git/**',
        '**/coverage/**',
        '**/.next/**',
        '**/.nuxt/**',
        '**/tsconfig*.json',
        '**/package*.json',
        '**/.eslintrc*.json',
        '**/jest.config.json',
        '**/cypress.json',
        '**/*.config.json',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/*.d.ts',
      ]
    });
    
    return files;
  } catch (error) {
    logger.debug(`Error scanning directory ${directory}: ${error}`);
    return [];
  }
}

/**
 * Find character files in common subdirectories (legacy function for compatibility)
 * 
 * @param directory - The root directory to search in
 * @returns Array of absolute file paths
 */
export function findCharacterFiles(directory: string): string[] {
  const characterFiles: string[] = [];
  
  // Common directories to search
  const searchDirs = [
    directory,
    path.join(directory, 'characters'),
    path.join(directory, 'agents'),
    path.join(directory, 'src', 'characters'),
    path.join(directory, 'src', 'agents'),
  ];
  
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.endsWith('.json') || file.endsWith('.ts')) {
          const fullPath = path.join(dir, file);
          characterFiles.push(fullPath);
        }
      }
    } catch (error) {
      // Skip directories we can't read
      logger.debug(`Could not read directory ${dir}: ${error}`);
    }
  }
  
  // Remove duplicates
  return [...new Set(characterFiles)];
}

/**
 * Check if a JSON object has the required structure of a character file
 * A valid character must have a name and at least one of: bio, system, or messageExamples
 * 
 * @param data - The parsed JSON data to validate
 * @returns True if it's a valid character structure
 */
export function isValidCharacterStructure(data: any): boolean {
  if (!data || typeof data !== 'object') {
    return false;
  }
  
  // Must have a name (string)
  if (!data.name || typeof data.name !== 'string') {
    return false;
  }
  
  // Must have at least one of these fields
  const hasRequiredField = 
    data.bio || 
    data.system || 
    (Array.isArray(data.messageExamples) && data.messageExamples.length > 0);
    
  return hasRequiredField;
}

/**
 * Check if a TypeScript file exports a character
 * This is a simple check that looks for common patterns
 * 
 * @param filePath - Path to the TypeScript file
 * @returns True if it likely exports a character
 */
export function hasCharacterExport(filePath: string): boolean {
  try {
    // Skip test files
    if (filePath.includes('__tests__') || 
        filePath.includes('.test.') || 
        filePath.includes('.spec.') ||
        filePath.includes('/test/') ||
        filePath.includes('/tests/')) {
      return false;
    }
    
    const content = fs.readFileSync(filePath, 'utf-8');
    
    // Skip files that import test utilities
    if (content.includes('vitest') || 
        content.includes('jest') || 
        content.includes('@testing-library') ||
        content.includes('describe(') ||
        content.includes('it(') ||
        content.includes('test(')) {
      return false;
    }
    
    // Look for patterns that indicate a character export
    const patterns = [
      // Direct character exports with proper structure
      /export\s+const\s+character\s*:\s*Character\s*=/,
      /export\s+const\s+\w+Character\s*:\s*Character\s*=/,
      /export\s+default\s+.*character.*:\s*Character/,
      
      // Character in a default export (e.g., project file)
      /export\s+default\s*{\s*[\s\S]*?character\s*:\s*{[\s\S]*?name\s*:/,
      /export\s+default\s*{\s*[\s\S]*?agents\s*:\s*\[[\s\S]*?character\s*:\s*{[\s\S]*?name\s*:/,
      
      // Named character exports with type annotation
      /export\s+const\s+\w+\s*:\s*Character\s*=\s*{[\s\S]*?name\s*:/,
    ];
    
    // Check if any pattern matches
    const hasCharacterPattern = patterns.some(pattern => pattern.test(content));
    
    // Additional validation: if we found a pattern, verify it has required fields
    if (hasCharacterPattern) {
      // Check for required character fields
      const hasName = /name\s*:\s*["'`][\w\s]+["'`]/.test(content);
      const hasBio = /bio\s*:\s*["'`][\s\S]+["'`]/.test(content) || 
                     /bio\s*:\s*\[[\s\S]*?\]/.test(content);
      
      return hasName && hasBio;
    }
    
    return false;
  } catch {
    return false;
  }
}

/**
 * Validate a character file (JSON or TypeScript)
 * 
 * @param filePath - Path to the file to validate
 * @returns True if it's a valid character file
 */
export async function isValidCharacterFile(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();
  
  if (ext === '.json') {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      return isValidCharacterStructure(data);
    } catch {
      return false;
    }
  } else if (ext === '.ts') {
    return hasCharacterExport(filePath);
  }
  
  return false;
}

/**
 * Load and validate character files from an array of paths
 * Combines path resolution and validation
 * 
 * @param characterPaths - Array of character paths to load
 * @returns Map of character names to their file paths
 */
export async function findCharactersFromPaths(
  characterPaths: string[]
): Promise<Map<string, string>> {
  const characterMap = new Map<string, string>();
  
  for (const characterPath of characterPaths) {
    try {
      const resolvedPath = resolveCharacterPath(characterPath);
      if (!resolvedPath) {
        logger.error(`Character file not found: ${characterPath}`);
        continue;
      }
      
      // Just validate and store the path, don't load the content
      const isValid = await isValidCharacterFile(resolvedPath);
      if (!isValid) {
        logger.error(`Invalid character file: ${characterPath}`);
        continue;
      }
      
      // Use the filename as a temporary key
      const baseName = path.basename(resolvedPath, path.extname(resolvedPath));
      characterMap.set(baseName, resolvedPath);
    } catch (error) {
      logger.error(`Failed to process character from ${characterPath}: ${error}`);
    }
  }
  
  return characterMap;
}

/**
 * Load a character file without logging
 * This is a simple wrapper around JSON parsing for cases where we don't want console output
 * 
 * @param filePath - Path to the character file
 * @returns Parsed character object
 * @throws Error if file cannot be read or parsed
 */
export async function loadCharacterQuietly(filePath: string): Promise<any> {
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Get the character name from a JSON file
 * 
 * @param filePath - Path to the JSON file
 * @returns The character name or null if not found
 */
export function getJsonCharacterName(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const character = JSON.parse(content);
    return character.name || null;
  } catch {
    return null;
  }
}

/**
 * Get the character name from a TypeScript file
 * This is a basic implementation that looks for common patterns
 * 
 * @param filePath - Path to the TypeScript file
 * @returns The character name or null if not found
 */
export function getTsCharacterName(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    
    // Look for name in various patterns
    const patterns = [
      // name: "CharacterName" or name: 'CharacterName'
      /name\s*:\s*["']([^"']+)["']/,
      // name: `CharacterName`
      /name\s*:\s*`([^`]+)`/,
      // "name": "CharacterName"
      /["']name["']\s*:\s*["']([^"']+)["']/,
    ];
    
    // First, try to find a character object
    // Look for character: { ... name: "..." ... }
    const characterMatch = content.match(/character\s*:\s*{[^}]*name\s*:\s*["'`]([^"'`]+)["'`]/);
    if (characterMatch?.[1]) {
      return characterMatch[1];
    }
    
    // Look for agents array with character
    const agentsMatch = content.match(/agents\s*:\s*\[[^\]]*character\s*:\s*{[^}]*name\s*:\s*["'`]([^"'`]+)["'`]/);
    if (agentsMatch?.[1]) {
      return agentsMatch[1];
    }
    
    // Look for const characterName: Character = { name: "..." }
    const typedCharMatch = content.match(/const\s+\w+\s*:\s*Character\s*=\s*{[^}]*name\s*:\s*["'`]([^"'`]+)["'`]/);
    if (typedCharMatch?.[1]) {
      return typedCharMatch[1];
    }
    
    // Fallback to simple patterns
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Get character info including name from a file
 * 
 * @param filePath - Path to the character file
 * @returns Object with name and path, or null if not valid
 */
export async function getCharacterInfo(filePath: string): Promise<{ name: string; path: string } | null> {
  const isValid = await isValidCharacterFile(filePath);
  if (!isValid) return null;
  
  let name: string | null = null;
  
  if (filePath.endsWith('.json')) {
    name = getJsonCharacterName(filePath);
  } else if (filePath.endsWith('.ts') || filePath.endsWith('.js')) {
    name = getTsCharacterName(filePath);
  }
  
  if (!name) {
    // Fallback to filename without extension
    name = path.basename(filePath, path.extname(filePath));
  }
  
  return { name, path: filePath };
} 