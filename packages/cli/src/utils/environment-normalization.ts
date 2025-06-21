import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { logger } from '@elizaos/core';

/**
 * Detect if we're running in a TypeScript or JavaScript environment
 */
export function detectRuntimeEnvironment(): 'typescript' | 'javascript' {
  // Check if we're running through ts-node or bun
  if (process.env.TS_NODE === '1' || process.execPath.includes('bun')) {
    return 'typescript';
  }

  // Check if the current file has .ts extension
  if (import.meta.url?.endsWith('.ts')) {
    return 'typescript';
  }

  // Default to JavaScript for built/distributed code
  return 'javascript';
}

/**
 * Normalize import paths based on the runtime environment
 * Adds .js extensions when needed for ESM compatibility
 */
export function normalizeImportPath(importPath: string): string {
  const env = detectRuntimeEnvironment();

  // Don't modify package imports or URLs
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
    return importPath;
  }

  // Don't modify if it already has an extension
  if (extname(importPath)) {
    return importPath;
  }

  // In JavaScript environment, add .js extension for relative imports
  if (env === 'javascript') {
    return `${importPath}.js`;
  }

  return importPath;
}

/**
 * Resolve a module path that works in both TS and JS environments
 */
export async function resolveModulePath(modulePath: string): Promise<string> {
  const env = detectRuntimeEnvironment();

  // Try the path as-is first
  if (existsSync(modulePath)) {
    return modulePath;
  }

  // Try with different extensions based on environment
  const extensions = env === 'typescript' ? ['.ts', '.js', '.mjs'] : ['.js', '.mjs'];

  for (const ext of extensions) {
    const pathWithExt = modulePath + ext;
    if (existsSync(pathWithExt)) {
      return pathWithExt;
    }
  }

  // Try index files
  for (const ext of extensions) {
    const indexPath = join(modulePath, `index${ext}`);
    if (existsSync(indexPath)) {
      return indexPath;
    }
  }

  // Return original path if nothing found
  return modulePath;
}

/**
 * Dynamic import that handles both TS and JS environments
 */
export async function dynamicImport(modulePath: string): Promise<any> {
  const resolvedPath = await resolveModulePath(modulePath);
  const normalizedPath = normalizeImportPath(resolvedPath);

  try {
    return await import(normalizedPath);
  } catch (error) {
    // If it fails, try with file:// protocol for absolute paths
    if (resolvedPath.startsWith('/')) {
      try {
        return await import(`file://${normalizedPath}`);
      } catch (fileError) {
        // Fall through to original error
      }
    }

    logger.debug(`Failed to import ${normalizedPath}:`, error);
    throw error;
  }
}

/**
 * Check if we're running inside a monorepo
 */
export function isMonorepoContext(): boolean {
  let currentDir = process.cwd();

  while (currentDir !== '/') {
    if (
      existsSync(join(currentDir, 'pnpm-workspace.yaml')) ||
      existsSync(join(currentDir, 'lerna.json')) ||
      existsSync(join(currentDir, 'rush.json'))
    ) {
      return true;
    }
    currentDir = join(currentDir, '..');
  }

  return false;
}

/**
 * Get the appropriate file extension for the current environment
 */
export function getFileExtension(): string {
  return detectRuntimeEnvironment() === 'typescript' ? '.ts' : '.js';
}

/**
 * Configuration for environment-specific behavior
 */
export interface EnvironmentConfig {
  isTypeScript: boolean;
  isMonorepo: boolean;
  requiresJsExtensions: boolean;
  canRunTypeScriptDirectly: boolean;
}

/**
 * Get comprehensive environment configuration
 */
export function getEnvironmentConfig(): EnvironmentConfig {
  const runtime = detectRuntimeEnvironment();
  const isTS = runtime === 'typescript';

  return {
    isTypeScript: isTS,
    isMonorepo: isMonorepoContext(),
    requiresJsExtensions: !isTS,
    canRunTypeScriptDirectly: isTS,
  };
}

/**
 * Create import statement with proper extension handling
 */
export function createImportStatement(
  importName: string,
  fromPath: string,
  isTypeDeclaration: boolean = false
): string {
  const normalizedPath = normalizeImportPath(fromPath);

  if (isTypeDeclaration) {
    return `import type { ${importName} } from '${normalizedPath}';`;
  }

  return `import { ${importName} } from '${normalizedPath}';`;
}

/**
 * Validate that required extensions are present in built environments
 */
export function validateImportExtensions(code: string): string[] {
  const env = detectRuntimeEnvironment();
  if (env === 'typescript') {
    return []; // No validation needed in TS environment
  }

  const issues: string[] = [];
  const importRegex = /import\s+(?:{[^}]+}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g;
  let match;

  while ((match = importRegex.exec(code)) !== null) {
    const importPath = match[1];

    // Check relative imports without extensions
    if (importPath.startsWith('.') && !extname(importPath)) {
      issues.push(`Missing .js extension on import: ${importPath}`);
    }
  }

  return issues;
}
