import type { PackageJson } from 'type-fest';
import { UserEnvironment } from './user-environment';

/**
 * Get the current version of a package from the monorepo
 */
/**
 * Retrieves the version of a specified package.
 *
 * @param {string} packageName - The name of the package to retrieve the version for.
 * @returns {Promise<string>} A promise that resolves with the version of the package.
 */
export async function getPackageVersion(packageName: string): Promise<string> {
  return UserEnvironment.getInstance().getPackageVersion(packageName);
}

/**
 * Get local packages available in the monorepo
 */
export async function getLocalPackages(): Promise<string[]> {
  return UserEnvironment.getInstance().getLocalPackages();
}

export async function getPackageInfo(): Promise<PackageJson> {
  const { packageJsonPath } = await UserEnvironment.getInstance().getPathInfo();
  try {
    const fileContent = await import('node:fs/promises').then((fs) =>
      fs.readFile(packageJsonPath, 'utf8')
    );
    return JSON.parse(fileContent) as PackageJson;
  } catch (error) {
    if (error instanceof Error) {
      // Check for file not found error (ENOENT)
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Error: Could not find package.json at ${packageJsonPath}`);
      }
      // Check for JSON parsing error
      if (error instanceof SyntaxError) {
        throw new Error(
          `Error: Invalid JSON in package.json at ${packageJsonPath}. Details: ${error.message}`
        );
      }
      // Rethrow other errors
      throw new Error(
        `Error reading or parsing package.json at ${packageJsonPath}: ${error.message}`
      );
    }
    // Fallback for non-Error objects thrown
    throw new Error(
      `An unexpected error occurred while reading or parsing package.json at ${packageJsonPath}`
    );
  }
}
