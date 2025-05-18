import { logger } from '@elizaos/core';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const CACHE_DIR = path.join(os.homedir(), '.eliza');
const CACHE_FILE_PATH = path.join(CACHE_DIR, 'parsed-registry.json');
const REGISTRY_URL =
  'https://raw.githubusercontent.com/elizaos-plugins/registry/refs/heads/main/index.json';

// --- Interfaces (copied from original, no changes needed) ---
interface CoreVersionInfo {
  coreDep: '1.x' | '0.x' | 'unknown';
  actual: string;
}
export interface NpmResolutionDetail {
  kind: 'npm';
  npmVersion: string;
}

export interface GitHubResolutionDetail {
  kind: 'github';
  coreDependency: string;
  branch: string;
}

export interface SlotResolutionInfo {
  // Effective resolution for this slot
  version: string | null;
  source: 'npmjs' | 'github-package.json' | null;
  resolutionDetail: NpmResolutionDetail | GitHubResolutionDetail | null; // MODIFIED from detail: string | null

  // NPM specific findings for this slot
  npmFound: boolean;
  npmVersion: string | null;

  // GitHub specific findings for this slot
  githubConfirmed: boolean;
  githubCoreVersion: string | null;
  githubBranch: string | null;
}

export interface PluginInfo {
  registryKey: string;
  githubLocator: string;
  isOfficialRepo: boolean;
  npmQueryName: string | null;
  versions: {
    v0: SlotResolutionInfo;
    v1: SlotResolutionInfo;
  };
  errors: string[];
}
// --- End Interfaces ---

interface CachedRegistry {
  lastUpdated: string;
  plugins: Record<string, PluginInfo>; // Changed from PluginInfo[]
}

let isUpdatingCache = false; // Prevent simultaneous background updates

// --- Helper functions (copied from original, no changes needed) ---
function findLatestVersion(versions: string[], prefix: string): string | null {
  if (!versions || !versions.length) return null;
  return (
    versions
      .filter((v) => v.startsWith(prefix))
      .map((v) => ({
        version: v,
        parts: v
          .substring(prefix.length)
          .split(/[-.]/)
          .map((p) => {
            const num = parseInt(p, 10);
            return isNaN(num) ? p : num;
          }),
      }))
      .sort((a, b) => {
        for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
          const partA =
            a.parts[i] === undefined ? (typeof b.parts[i] === 'number' ? 0 : '') : a.parts[i];
          const partB =
            b.parts[i] === undefined ? (typeof a.parts[i] === 'number' ? 0 : '') : b.parts[i];
          if (typeof partA !== typeof partB) {
            return typeof partA === 'number' ? -1 : 1;
          }
          if (partA !== partB) {
            return partB > partA ? 1 : -1;
          }
        }
        return 0;
      })[0]?.version || null
  );
}

function getElizaOsCoreVersionInfo(packageJsonContent: string): CoreVersionInfo | null {
  if (!packageJsonContent) return null;
  try {
    const pkg = JSON.parse(packageJsonContent);
    const coreVersionString =
      pkg.dependencies?.['@elizaos/core'] || pkg.devDependencies?.['@elizaos/core'];
    if (coreVersionString) {
      if (
        coreVersionString.match(/^(\^|~)?1\./) ||
        coreVersionString.toLowerCase() === '1.x' ||
        coreVersionString === '*'
      ) {
        return { coreDep: '1.x', actual: coreVersionString };
      }
      if (coreVersionString.match(/^(\^|~)?0\./) || coreVersionString.toLowerCase() === '0.x') {
        return { coreDep: '0.x', actual: coreVersionString };
      }
      return { coreDep: 'unknown', actual: coreVersionString };
    }
  } catch (e: any) {
    logger.warn(`Error parsing package.json for core version: ${e.message}`);
  }
  return null;
}

async function fetchAndParsePackageJson(pkgJsonUrl: string): Promise<CoreVersionInfo | null> {
  try {
    const pkgJsonRes = await fetch(pkgJsonUrl, { cache: 'no-store' });
    if (pkgJsonRes.ok) {
      const pkgJsonText = await pkgJsonRes.text();
      return getElizaOsCoreVersionInfo(pkgJsonText);
    }
  } catch (err: any) {
    logger.debug(`Network error fetching ${pkgJsonUrl}: ${err.message}`);
  }
  return null;
}
// --- End Helper functions ---

export async function readCache(): Promise<CachedRegistry | null> {
  try {
    const fileContent = await fs.readFile(CACHE_FILE_PATH, 'utf-8');
    if (!fileContent) return null;
    const parsed = JSON.parse(fileContent) as CachedRegistry;
    // Basic validation for the new structure
    if (
      parsed &&
      parsed.lastUpdated &&
      typeof parsed.plugins === 'object' &&
      parsed.plugins !== null &&
      !Array.isArray(parsed.plugins)
    ) {
      return parsed;
    }
    logger.warn('Cache file is malformed or uses an outdated array format.');
    return null;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      logger.info('Cache file not found. Will fetch fresh data.');
    } else {
      logger.error(`Error reading cache file: ${error.message}`);
    }
    return null;
  }
}

export async function writeCache(plugins: Record<string, PluginInfo>): Promise<void> {
  try {
    logger.trace('[Cache] Writing cache. Path: %s, Dir: %s', CACHE_FILE_PATH, CACHE_DIR);
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const cacheData: CachedRegistry = {
      lastUpdated: new Date().toISOString(),
      plugins: plugins,
    };
    await fs.writeFile(CACHE_FILE_PATH, JSON.stringify(cacheData, null, 2), 'utf-8');
    logger.trace('[Cache] Successfully wrote cache to: %s', CACHE_FILE_PATH);
    logger.info(`Plugin registry cache updated at ${CACHE_FILE_PATH}`);
  } catch (error: any) {
    logger.error(`Error writing cache file: ${error.message}`);
    throw error;
  }
}

async function _processSinglePluginEntry(
  registryKey: string,
  githubLocator: string
): Promise<PluginInfo> {
  logger.trace(`Processing plugin entry: ${registryKey} -> ${githubLocator}`);

  const isOfficialRepo = githubLocator.startsWith('github:elizaos-plugins/');
  let npmPackageNameToQuery: string | null = null;

  const initialNpmQueryName = isOfficialRepo
    ? registryKey.replace('@elizaos-plugins/', '@elizaos/')
    : registryKey;

  const pluginData: PluginInfo = {
    registryKey,
    githubLocator,
    isOfficialRepo,
    npmQueryName: initialNpmQueryName, // Will be updated if a different name succeeds for unofficial
    versions: {
      v0: {
        version: null,
        source: null,
        resolutionDetail: null,
        npmFound: false,
        npmVersion: null,
        githubConfirmed: false,
        githubCoreVersion: null,
        githubBranch: null,
      },
      v1: {
        version: null,
        source: null,
        resolutionDetail: null,
        npmFound: false,
        npmVersion: null,
        githubConfirmed: false,
        githubCoreVersion: null,
        githubBranch: null,
      },
    },
    errors: [],
  };

  // 1. Try NPM
  let npmNamesToTry: string[] = [];
  if (isOfficialRepo) {
    if (initialNpmQueryName) npmNamesToTry.push(initialNpmQueryName);
  } else {
    // Unofficial: try registryKey, then derived from GitHub locator
    if (initialNpmQueryName) npmNamesToTry.push(initialNpmQueryName); // e.g. @elizaos-plugins/plugin-bitquery
    if (githubLocator.startsWith('github:')) {
      const repoPathOnly = githubLocator.substring('github:'.length).split('#')[0]; // Remove 'github:' and any #branch
      const parts = repoPathOnly.split('/');
      if (parts.length === 2) {
        const owner = parts[0];
        const repoName = parts[1];
        const ownerScopedName = `@${owner}/${repoName}`;
        if (!npmNamesToTry.includes(ownerScopedName)) npmNamesToTry.push(ownerScopedName); // e.g. @chuxo/plugin-bitquery
        if (!npmNamesToTry.includes(repoName)) npmNamesToTry.push(repoName); // e.g. plugin-bitquery
      }
    }
  }
  // Remove duplicates just in case, though logic above tries to avoid them
  npmNamesToTry = [...new Set(npmNamesToTry)];

  let npmSearchSuccess = false;
  if (npmNamesToTry.length > 0) {
    for (const currentNpmName of npmNamesToTry) {
      if (!currentNpmName) continue; // Should not happen with current logic but good check
      try {
        const npmUrl = `https://registry.npmjs.org/${encodeURIComponent(currentNpmName)}`;
        logger.trace(`  Querying NPM: ${npmUrl} (attempt for ${registryKey})`);
        const npmRes = await fetch(npmUrl, { cache: 'no-store' });
        if (npmRes.ok) {
          const npmData = await npmRes.json();
          const versions = Object.keys(npmData.versions || {});
          const latest0x = findLatestVersion(versions, '0.');
          const latest1x = findLatestVersion(versions, '1.');

          let foundThisAttempt = false;
          if (latest0x) {
            pluginData.versions.v0 = {
              ...pluginData.versions.v0,
              version: latest0x,
              source: 'npmjs',
              resolutionDetail: { kind: 'npm', npmVersion: latest0x },
              npmFound: true,
              npmVersion: latest0x,
            };
            foundThisAttempt = true;
          }
          if (latest1x) {
            pluginData.versions.v1 = {
              ...pluginData.versions.v1,
              version: latest1x,
              source: 'npmjs',
              resolutionDetail: { kind: 'npm', npmVersion: latest1x },
              npmFound: true,
              npmVersion: latest1x,
            };
            foundThisAttempt = true;
          }

          if (foundThisAttempt) {
            logger.info(
              `  NPM success for ${registryKey} with name ${currentNpmName}: 0.x=${latest0x || 'N/A'}, 1.x=${latest1x || 'N/A'}`
            );
            pluginData.npmQueryName = currentNpmName; // Update to the successful name
            npmSearchSuccess = true;
            // Clear only 404 errors from previous attempts for THIS plugin if this one succeeds
            pluginData.errors = pluginData.errors.filter(
              (e) => !e.startsWith('NPM package') || !e.includes('not found (404).')
            );
            break; // Found on NPM, stop trying other names
          }
        } else {
          logger.trace(`  NPM status for ${currentNpmName}: ${npmRes.status}`);
          if (npmRes.status === 404) {
            // Only add error if it's the last name to try or if being verbose
            if (
              npmNamesToTry.indexOf(currentNpmName) === npmNamesToTry.length - 1 ||
              npmNamesToTry.length === 1
            ) {
              pluginData.errors.push(`NPM package ${currentNpmName} not found (404).`);
            }
          } else {
            pluginData.errors.push(`NPM error for ${currentNpmName}: status ${npmRes.status}`);
          }
        }
      } catch (err: any) {
        logger.trace(`  NPM fetch error for ${currentNpmName}: ${err.message}`);
        pluginData.errors.push(`NPM fetch error for ${currentNpmName}: ${err.message}`);
      }
    }
  } else {
    logger.trace('  No NPM package names to query (was empty or invalid).');
    pluginData.errors.push('No valid NPM package name to query.');
  }

  // 2. If not fully resolved via NPM, try GitHub package.json
  if (githubLocator.startsWith('github:')) {
    const repoPathWithPotentialBranch = githubLocator.replace('github:', '');
    const [repoPath, githubBranchFromLocator] = repoPathWithPotentialBranch.split('#');

    const branchesToCheck: string[] = [];
    if (githubBranchFromLocator && githubBranchFromLocator.trim() !== '')
      branchesToCheck.push(githubBranchFromLocator);
    // Ensure common branches are checked, avoiding duplicates if one was specified in githubBranchFromLocator
    ['1.x', '0.x', 'main', 'master', 'v2-develop', 'latest'].forEach((b) => {
      if (!branchesToCheck.includes(b)) branchesToCheck.push(b);
    });

    for (const branchName of branchesToCheck) {
      // Removed early exit: if (v0ResolvedByNpm && v1ResolvedByNpm) break;
      // We always check GitHub to potentially override compatibility source/detail.

      const pkgJsonUrl = `https://raw.githubusercontent.com/${repoPath}/${branchName}/package.json`;
      logger.trace(`  Checking GitHub: ${pkgJsonUrl}`);
      const coreInfo = await fetchAndParsePackageJson(pkgJsonUrl);

      if (coreInfo) {
        logger.trace(
          `  GitHub package.json on branch ${branchName} for ${repoPath} has @elizaos/core: ${coreInfo.actual} (interpreted as ${coreInfo.coreDep})`
        );
        const githubVersionDetail = `@elizaos/core: ${coreInfo.actual} (branch: ${branchName})`;
        const githubSourceDetail = 'github-package.json';
        let githubDerivedVersionString = `core:${coreInfo.coreDep}-via-github`; // Generic placeholder if NPM version is absent

        if (coreInfo.coreDep === '1.x') {
          const versionToSet = pluginData.versions.v1.npmFound
            ? pluginData.versions.v1.npmVersion
            : githubDerivedVersionString;
          pluginData.versions.v1 = {
            ...pluginData.versions.v1,
            version: versionToSet,
            source: 'github-package.json',
            resolutionDetail: {
              kind: 'github',
              coreDependency: coreInfo.actual,
              branch: branchName,
            },
            githubConfirmed: true,
            githubCoreVersion: coreInfo.actual,
            githubBranch: branchName,
          };
          logger.trace(
            `    GitHub check (${branchName}) for ${registryKey} confirmed v1 compatibility: ${coreInfo.actual}`
          );
        } else if (coreInfo.coreDep === '0.x') {
          const versionToSet = pluginData.versions.v0.npmFound
            ? pluginData.versions.v0.npmVersion
            : githubDerivedVersionString;
          pluginData.versions.v0 = {
            ...pluginData.versions.v0,
            version: versionToSet,
            source: 'github-package.json',
            resolutionDetail: {
              kind: 'github',
              coreDependency: coreInfo.actual,
              branch: branchName,
            },
            githubConfirmed: true,
            githubCoreVersion: coreInfo.actual,
            githubBranch: branchName,
          };
          logger.trace(
            `    GitHub check (${branchName}) for ${registryKey} confirmed v0 compatibility: ${coreInfo.actual}`
          );
        } else if (coreInfo.coreDep === 'unknown') {
          // If GitHub says 'unknown', we don't have enough info from GitHub to assign it to a v0/v1 slot.
          // We won't override any existing NPM-derived version info in this case.
          // If desired, one could clear a slot if GitHub says 'unknown' and NPM had populated it,
          // but for now, we'll be less destructive.
          logger.trace(
            `  GitHub core dependency for ${repoPath} on branch ${branchName} is 'unknown' (${coreInfo.actual}). No compatibility slot assigned from this source.`
          );
        }

        // Optimization: if both v0 and v1 slots are now definitively sourced from GitHub
        // (meaning this branch provided info for at least one, and the other might have been from a previous branch or also this one)
        // and we are not trying to find specific NPM versions anymore, we *could* break.
        // However, let's allow checking all specified/common branches to get the most precise/latest core dep.
        // The original break condition: if (pluginData.versions.v0.source === githubSourceDetail && pluginData.versions.v1.source === githubSourceDetail) break;
        // For now, let's remove this break to ensure all relevant branches are checked for potentially newer core deps.
      } else {
        logger.trace(`  No package.json or no @elizaos/core dep found at ${pkgJsonUrl}`);
      }
    }
  } else {
    pluginData.errors.push(`GitHub locator '${githubLocator}' does not start with 'github:'.`);
  }
  return pluginData;
}

export async function updatePluginRegistryCache(): Promise<boolean> {
  logger.info('Starting plugin registry update...');
  try {
    const plugins = await _fetchAndProcessRemoteRegistry();
    if (plugins) {
      await writeCache(plugins); // writeCache already logs its own success/failure regarding write
      logger.info('Plugin registry cache update process completed.');
      return true;
    } else {
      logger.warn('Failed to fetch and process remote plugin registry. Cache not updated.');
      return false;
    }
  } catch (error: any) {
    logger.error(`Critical error during plugin registry update: ${error.message}`);
    return false;
  }
}

async function _fetchAndProcessRemoteRegistry(): Promise<Record<string, PluginInfo> | null> {
  logger.info(`Fetching plugin registry from ${REGISTRY_URL}...`);
  try {
    const res = await fetch(REGISTRY_URL, { cache: 'no-store' });
    if (!res.ok) {
      logger.error(`Registry fetch failed: ${res.status}`);
      return null; // Changed from throw to return null for graceful background failure
    }
    const registryObj = (await res.json()) as Record<string, string>;
    logger.info(`Registry fetched. Processing ${Object.keys(registryObj).length} entries.`);

    const processingPromises = Object.entries(registryObj)
      .filter(([registryKey]) => {
        if (!registryKey) {
          logger.warn('Skipping empty registry key found in remote index.json.');
          return false;
        }
        return true;
      })
      .map(([registryKey, githubLocator]) => _processSinglePluginEntry(registryKey, githubLocator));

    const resultsArray = await Promise.all(processingPromises);
    logger.info(`Finished processing ${resultsArray.length} plugins from registry (parallelized).`);

    const pluginsMap: Record<string, PluginInfo> = {};
    resultsArray.forEach((plugin) => {
      if (plugin && plugin.registryKey) {
        // Ensure plugin and registryKey are valid
        pluginsMap[plugin.registryKey] = plugin;
      }
    });
    return pluginsMap;
  } catch (err: any) {
    logger.error(`Critical error fetching or processing plugin registry: ${err.message}`);
    if (err instanceof Error && err.stack) {
      logger.error(err.stack);
    }
    throw err;
  }
}

export async function fetchPluginRegistryInfo(): Promise<Record<string, PluginInfo>> {
  logger.trace('[Cache] fetchPluginRegistryInfo called');
  const cachedData = await readCache();

  if (cachedData) {
    logger.trace('[Cache] Cache HIT. Data loaded and will be served.');
    logger.info('Using cached plugin registry info.');

    if (!isUpdatingCache) {
      isUpdatingCache = true;
      logger.info('Initiating background update for plugin registry cache...');
      _fetchAndProcessRemoteRegistry()
        .then(async (newPlugins) => {
          if (newPlugins) {
            // Comparing objects; JSON.stringify should be reasonably stable for key order for the same object structure.
            // For a more robust comparison, a deep-equal utility could be used, but this is often sufficient.
            if (JSON.stringify(cachedData.plugins) !== JSON.stringify(newPlugins)) {
              logger.info(
                'Background update: Changes detected in plugin registry. Updating cache.'
              );
              await writeCache(newPlugins);
            } else {
              logger.info(
                'Background update: No changes in plugin registry. Cache remains current.'
              );
            }
          }
        })
        .catch((error) => {
          logger.error(`Background cache update failed: ${error.message}`);
        })
        .finally(() => {
          isUpdatingCache = false;
          logger.info('Background cache update process finished.');
        });
    } else {
      logger.info('Background cache update already in progress.');
    }
    return cachedData.plugins;
  }

  logger.trace('[Cache] Cache MISS or EXPIRED; preparing to fetch fresh data.');
  logger.info('Fetching fresh plugin registry info (cache miss or invalid)...');
  const newPlugins = await _fetchAndProcessRemoteRegistry();

  if (newPlugins) {
    logger.trace('[Cache] Fresh fetch successful, proceeding to write cache.');
    await writeCache(newPlugins);
    return newPlugins;
  } else {
    logger.error('Failed to fetch fresh plugin data. Returning empty object.');
    return {};
  }
}
