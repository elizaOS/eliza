import { Dependencies } from '../types';

/**
 * Normalizes a plugin input string to a standard format, typically 'plugin-name'.
 * Used primarily for display and generating commands in bunx instructions.
 */
export const normalizePluginNameForDisplay = (pluginInput: string): string => {
  let baseName = pluginInput;

  // Handle scoped formats like "@scope/plugin-name" or "scope/plugin-name"
  if (pluginInput.includes('/')) {
    const parts = pluginInput.split('/');
    baseName = parts[parts.length - 1];
  }
  // Remove potential scope from "@plugin-name" - less common but possible
  else if (pluginInput.startsWith('@')) {
    const parts = pluginInput.split('/'); // Re-split in case it was just "@plugin-name"
    if (parts.length > 1) {
      baseName = parts[1];
    } else {
      // Assume it's like "@something" without a scope/name separator - maybe log a warning?
      // For now, let's just take the part after '@'
      baseName = pluginInput.substring(1);
    }
  }

  // Ensure it starts with 'plugin-' and remove duplicates if necessary
  baseName = baseName.replace(/^plugin-/, ''); // Remove existing prefix first
  return `plugin-${baseName}`; // Add the prefix back
};

/**
 * Finds the actual package name in dependencies based on various input formats.
 */
export const findPluginPackageName = (
  pluginInput: string,
  allDependencies: Dependencies
): string | null => {
  // Normalize the input to a base form (e.g., 'abc' from 'plugin-abc')
  let normalizedBase = pluginInput.startsWith('@')
    ? pluginInput.split('/')[1] || pluginInput
    : pluginInput;
  normalizedBase = normalizedBase.replace(/^plugin-/, ''); // Remove prefix if present

  // Potential package names to check (prioritize @elizaos/ over @elizaos/)
  const possibleNames = [
    pluginInput, // Check the raw input first
    `@elizaos/plugin-${normalizedBase}`, // Prioritize @elizaos/ scope
    `@elizaos/${normalizedBase}`, // Might be needed if input was 'plugin-abc' -> base 'abc' -> check '@elizaos/abc'
    `@elizaos/plugin-${normalizedBase}`, // Check alternative scope
    `plugin-${normalizedBase}`,
    `@elizaos/${normalizedBase}`,
  ];

  for (const name of possibleNames) {
    if (allDependencies[name]) {
      return name; // Return the first matching key found in dependencies
    }
  }

  return null; // Not found
};

/**
 * Extracts the actual npm package name from various input formats.
 * This function handles GitHub URLs, package names, and repository names
 * but preserves the exact package name for installation.
 */
export const extractPackageName = (pluginInput: string): string => {
  // Handle GitHub URLs and repository names
  const githubUrlRegex =
    /^https?:\/\/github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?(?:#([a-zA-Z0-9_.-]+))?$/;
  const githubShortRegex =
    /^(?:github:)?([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)(?:#([a-zA-Z0-9_.-]+))?$/;

  // Check for GitHub URL format first
  const githubUrlMatch = pluginInput.match(githubUrlRegex);
  if (githubUrlMatch) {
    const [, owner, repo] = githubUrlMatch;
    // For GitHub repos, we typically expect the package name to be scoped
    // e.g., github:elizaos-plugins/plugin-discord -> @elizaos/plugin-discord
    return `@${owner}/${repo}`;
  }

  // Check for GitHub shorthand format
  const githubShortMatch = pluginInput.match(githubShortRegex);
  if (githubShortMatch) {
    const [, owner, repo] = githubShortMatch;
    return `@${owner}/${repo}`;
  }

  // Return the input as-is for regular package names
  return pluginInput;
};
