/**
 * Character Path Parser Utility
 *
 * This utility handles parsing character paths from command line arguments,
 * supporting multiple formats including comma-separated values, quotes, etc.
 */

/**
 * Parse character paths from command line arguments
 * Handles multiple formats:
 * - Space-separated: billy bobby
 * - Comma-separated: billy,bobby
 * - Comma with spaces: "billy, bobby"
 * - Single quotes: 'billy, bobby'
 * - Double quotes: "billy, bobby"
 * - Mixed formats: "'billy.json'" "bobby"
 *
 * @param characterPaths - Raw character paths from command line
 * @returns Parsed array of individual character paths
 */
export function parseCharacterPaths(characterPaths?: string[] | string): string[] {
  if (!characterPaths) {
    return [];
  }

  // Ensure we have an array
  const paths = Array.isArray(characterPaths) ? characterPaths : [characterPaths];

  // Split any comma-separated values and flatten the array
  const expandedPaths: string[] = [];

  for (const path of paths) {
    // Remove surrounding quotes if present
    const cleanPath = path.replace(/^["']|["']$/g, '');

    // Split by comma and trim whitespace
    const parts = cleanPath
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    expandedPaths.push(...parts);
  }

  // Remove any duplicates
  return [...new Set(expandedPaths)];
}

/**
 * Normalize character paths for consistent handling
 * This can be extended with additional normalization rules as needed
 *
 * @param paths - Array of character paths
 * @returns Normalized paths
 */
export function normalizeCharacterPaths(paths: string[]): string[] {
  return paths
    .map((path) => {
      // Remove any extra quotes that might have been missed
      return path.replace(/^["']|["']$/g, '').trim();
    })
    .filter((p) => p.length > 0);
}
