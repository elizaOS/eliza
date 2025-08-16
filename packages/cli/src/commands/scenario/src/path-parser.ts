/**
 * Path Parser Utilities for Parameter Override System
 *
 * This module provides utilities for parsing and manipulating dot-notation paths
 * with array indexing support. Required by ticket #5780.
 */

/**
 * Represents a parsed parameter path with segments and metadata.
 */
export interface ParameterPath {
  /** Array of path segments, where numbers represent array indices */
  segments: (string | number)[];
  /** Whether the path contains array access notation */
  hasArrayAccess: boolean;
  /** Original path string */
  originalPath: string;
}

/**
 * Cache for parsed paths to improve performance with repeated operations.
 */
const pathCache = new Map<string, ParameterPath>();

/**
 * Parses a dot-notation parameter path into segments.
 *
 * Supports:
 * - Simple paths: "character.name"
 * - Nested paths: "character.llm.model"
 * - Array access: "run[0].input"
 * - Mixed access: "plugins[1].config.apiKey"
 *
 * @param path - The dot-notation path to parse
 * @returns Parsed path object with segments
 * @throws Error if the path is malformed
 *
 * @example
 * ```typescript
 * parseParameterPath("character.llm.model")
 * // Returns: { segments: ["character", "llm", "model"], hasArrayAccess: false }
 *
 * parseParameterPath("run[0].input")
 * // Returns: { segments: ["run", 0, "input"], hasArrayAccess: true }
 * ```
 */
export function parseParameterPath(path: string): ParameterPath {
  // Check cache first for performance
  if (pathCache.has(path)) {
    return pathCache.get(path)!;
  }

  if (!path || typeof path !== 'string') {
    throw new Error('Path must be a non-empty string');
  }

  // Check for invalid starting/ending characters
  if (path.startsWith('.') || path.endsWith('.')) {
    throw new Error('Path cannot start or end with a dot');
  }

  const segments: (string | number)[] = [];
  let hasArrayAccess = false;
  let currentSegment = '';
  let i = 0;
  let lastCharWasArrayClose = false;

  while (i < path.length) {
    const char = path[i];

    if (char === '.') {
      if (currentSegment === '' && !lastCharWasArrayClose) {
        // This is a double dot or leading dot - invalid (unless following array close)
        throw new Error('Empty segment in path (double dots or leading/trailing dots not allowed)');
      } else if (currentSegment === '' && i === 0) {
        // Leading dot
        throw new Error('Path cannot start or end with a dot');
      } else if (currentSegment !== '') {
        segments.push(currentSegment);
        currentSegment = '';
      }
      // If currentSegment is empty but lastCharWasArrayClose is true, we just continue
      lastCharWasArrayClose = false;
    } else if (char === '[') {
      // Handle array index
      if (currentSegment === '') {
        throw new Error('Array access must follow a property name');
      }

      // Push the property name before the array index
      segments.push(currentSegment);
      currentSegment = '';

      // Find the closing bracket
      const closingBracket = path.indexOf(']', i);
      if (closingBracket === -1) {
        throw new Error('Missing closing bracket for array index');
      }

      const indexStr = path.substring(i + 1, closingBracket);
      if (!/^\d+$/.test(indexStr)) {
        throw new Error(`Invalid array index: ${indexStr}`);
      }

      const index = parseInt(indexStr, 10);
      segments.push(index);
      hasArrayAccess = true;

      i = closingBracket;
      lastCharWasArrayClose = true;
    } else if (char === ']') {
      throw new Error('Unexpected closing bracket');
    } else {
      currentSegment += char;
      lastCharWasArrayClose = false;
    }

    i++;
  }

  // Add the final segment if it exists
  if (currentSegment !== '') {
    segments.push(currentSegment);
  } else if (path.endsWith('.')) {
    throw new Error('Path cannot start or end with a dot');
  }

  if (segments.length === 0) {
    throw new Error('Path cannot be empty');
  }

  // Validate property names
  for (const segment of segments) {
    if (typeof segment === 'string') {
      // Check for valid JavaScript property names
      if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(segment)) {
        throw new Error(`Invalid property name in path: '${segment}'`);
      }
    }
  }

  const result: ParameterPath = {
    segments,
    hasArrayAccess,
    originalPath: path,
  };

  // Cache the result for future lookups
  pathCache.set(path, result);

  return result;
}

/**
 * Validates a parameter path string without fully parsing it.
 * Useful for quick validation checks.
 *
 * @param path - The path string to validate
 * @returns True if the path has valid syntax
 */
export function isValidPathSyntax(path: string): boolean {
  try {
    parseParameterPath(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalizes a parameter path by removing extra dots and spaces.
 * Useful for cleaning user input.
 *
 * @param path - The path to normalize
 * @returns Normalized path string
 */
export function normalizeParameterPath(path: string): string {
  if (!path || typeof path !== 'string') {
    return '';
  }

  // Remove extra whitespace
  let normalized = path.trim();

  // Remove double dots
  normalized = normalized.replace(/\.+/g, '.');

  // Remove leading/trailing dots
  normalized = normalized.replace(/^\.+|\.+$/g, '');

  return normalized;
}

/**
 * Suggests corrections for common path mistakes.
 *
 * @param invalidPath - The invalid path that failed validation
 * @returns Array of suggested corrections
 */
export function suggestPathCorrections(invalidPath: string): string[] {
  const suggestions: string[] = [];

  // Common mistake: using dots instead of brackets for arrays
  if (invalidPath.includes('.0') || invalidPath.includes('.1') || invalidPath.includes('.2')) {
    const corrected = invalidPath.replace(/\.(\d+)/g, '[$1]');
    suggestions.push(corrected);
  }

  // Common mistake: missing closing bracket
  if (invalidPath.includes('[') && !invalidPath.includes(']')) {
    // Check if there's a dot after the opening bracket that should be a closing bracket
    const dotAfterBracket = invalidPath.match(/\[(\d+)\.(.+)$/);
    if (dotAfterBracket) {
      const corrected = invalidPath.replace(/\[(\d+)\./, '[$1].');
      suggestions.push(corrected);
    } else {
      const corrected = invalidPath + ']';
      suggestions.push(corrected);
    }
  }

  // Common mistake: extra dots
  if (invalidPath.includes('..')) {
    const corrected = invalidPath.replace(/\.+/g, '.');
    suggestions.push(corrected);
  }

  return suggestions;
}

/**
 * Gets the parent path of a given parameter path.
 *
 * @param path - The parameter path
 * @returns Parent path string, or null if path has no parent
 *
 * @example
 * ```typescript
 * getParentPath("character.llm.model") // "character.llm"
 * getParentPath("run[0].input") // "run[0]"
 * getParentPath("name") // null
 * ```
 */
export function getParentPath(path: string): string | null {
  try {
    const parsed = parseParameterPath(path);
    if (parsed.segments.length <= 1) {
      return null;
    }

    const parentSegments = parsed.segments.slice(0, -1);
    return reconstructPath(parentSegments);
  } catch {
    return null;
  }
}

/**
 * Reconstructs a path string from parsed segments.
 *
 * @param segments - Array of path segments
 * @returns Reconstructed path string
 */
export function reconstructPath(segments: (string | number)[]): string {
  let path = '';

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (typeof segment === 'number') {
      path += `[${segment}]`;
    } else {
      // Add dot before string segments, except at the start or right after the start
      if (i > 0) {
        path += '.';
      }
      path += segment;
    }
  }

  return path;
}

/**
 * Clears the path parsing cache.
 * Useful for testing or memory management.
 */
export function clearPathCache(): void {
  pathCache.clear();
}

/**
 * Gets cache statistics for debugging and performance monitoring.
 */
export function getPathCacheStats(): { size: number; hitRate?: number } {
  return {
    size: pathCache.size,
    // Note: Hit rate tracking could be added with additional counters
  };
}
