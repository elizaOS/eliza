import { type ConfigLoaderSuccessResult, createMatchPath } from 'tsconfig-paths';

/**
 * Asynchronously resolves an import path by matching it against the base URL and paths defined in the provided configuration.
 *
 * @param {string} importPath - The path of the import to resolve.
 * @param {Pick<ConfigLoaderSuccessResult, "absoluteBaseUrl" | "paths">} config - The configuration object containing the absolute base URL and paths mappings.
 * @returns {string|null} - The resolved absolute path if a match is found, otherwise null.
 */
export async function resolveImport(
  importPath: string,
  config: Pick<ConfigLoaderSuccessResult, 'absoluteBaseUrl' | 'paths'>
) {
  return createMatchPath(config.absoluteBaseUrl, config.paths)(importPath, undefined, () => true, [
    '.ts',
  ]);
}
