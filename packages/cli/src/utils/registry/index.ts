import { getGitHubCredentials, getLocalPackages, resolveEnvFile } from '@/src/utils';
import { detectDirectoryType } from '@/src/utils/directory-detection';
import { logger } from '@elizaos/core';
import dotenv from 'dotenv';
import { bunExecSimple } from '../bun-exec.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { REGISTRY_ORG, REGISTRY_REPO, REGISTRY_URL, RAW_REGISTRY_URL } from './constants';

const ELIZA_DIR = path.join(process.cwd(), '.eliza');
const REGISTRY_SETTINGS_FILE = path.join(ELIZA_DIR, 'registrysettings.json');
// Use resolveEnvFile to match how credentials are saved, with fallback to ~/.eliza/.env
const ENV_FILE = resolveEnvFile() || path.join(ELIZA_DIR, '.env');
const REGISTRY_CACHE_FILE = path.join(ELIZA_DIR, 'registry-cache.json');

const REQUIRED_ENV_VARS = ['GITHUB_TOKEN'] as const;
const REQUIRED_SETTINGS = ['defaultRegistry'] as const;

export interface RegistrySettings {
  defaultRegistry: string;
  publishConfig?: {
    registry: string;
    username?: string;
    useNpm?: boolean;
    platform?: 'node' | 'browser' | 'universal';
  };
}

export interface DataDirStatus {
  exists: boolean;
  env: {
    exists: boolean;
    missingKeys: string[];
    hasAllKeys: boolean;
  };
  settings: {
    exists: boolean;
    missingKeys: string[];
    hasAllKeys: boolean;
  };
}

export async function ensureElizaDir() {
  try {
    await fs.mkdir(ELIZA_DIR, { recursive: true });
  } catch (error) {
    // Directory already exists
  }
}

export async function getRegistrySettings(): Promise<RegistrySettings> {
  await ensureElizaDir();

  try {
    const content = await fs.readFile(REGISTRY_SETTINGS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    // Return default settings if file doesn't exist
    return {
      defaultRegistry: REGISTRY_REPO,
    };
  }
}

export async function saveRegistrySettings(settings: RegistrySettings) {
  await ensureElizaDir();
  await fs.writeFile(REGISTRY_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export async function getEnvVar(key: string): Promise<string | undefined> {
  try {
    const envContent = await fs.readFile(ENV_FILE, 'utf-8');
    const env = dotenv.parse(envContent);
    return env[key];
  } catch (error) {
    return undefined;
  }
}

export async function setEnvVar(key: string, value: string) {
  await ensureElizaDir();

  let envContent = '';
  try {
    envContent = await fs.readFile(ENV_FILE, 'utf-8');
  } catch (error) {
    // File doesn't exist yet
  }

  const env = dotenv.parse(envContent);
  env[key] = value;

  const newContent = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  await fs.writeFile(ENV_FILE, newContent);
}

export async function getGitHubToken(): Promise<string | undefined> {
  try {
    // Try to find the nearest .env file using the same function used for saving credentials
    const envPath = resolveEnvFile();
    if (envPath && existsSync(envPath)) {
      const envContent = await fs.readFile(envPath, 'utf-8');
      const env = dotenv.parse(envContent);
      return env.GITHUB_TOKEN;
    }

    // Fall back to global .env if local one doesn't exist or doesn't have token
    const globalEnvPath = path.join(ELIZA_DIR, '.env');
    if (existsSync(globalEnvPath) && globalEnvPath !== envPath) {
      const envContent = await fs.readFile(globalEnvPath, 'utf-8');
      const env = dotenv.parse(envContent);
      return env.GITHUB_TOKEN;
    }
  } catch (error) {
    logger.debug(
      `Error reading GitHub token: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return undefined;
}

export async function setGitHubToken(token: string) {
  await ensureElizaDir();

  try {
    // Read existing .env file or create a new one
    let envContent = '';
    try {
      if (existsSync(ENV_FILE)) {
        envContent = await fs.readFile(ENV_FILE, 'utf-8');
      }
    } catch (error) {
      // File doesn't exist, create it with empty content
      envContent = '# Eliza environment variables\n\n';
    }

    // Parse the existing content
    const env = dotenv.parse(envContent);

    // Update the token
    env.GITHUB_TOKEN = token;

    // Convert back to string format
    let newContent = '';
    for (const [key, value] of Object.entries(env)) {
      newContent += `${key}=${value}\n`;
    }

    // Write back to file
    await fs.writeFile(ENV_FILE, newContent);

    // Also update process.env for immediate use
    process.env.GITHUB_TOKEN = token;

    logger.debug('GitHub token saved successfully');
  } catch (error) {
    logger.error(
      `Failed to save GitHub token: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Normalizes a package name by removing scope prefixes
 * @param packageName The package name to normalize
 * @returns The normalized package name without scope prefix
 */
function normalizePackageName(packageName: string): string {
  if (packageName.startsWith(`@${REGISTRY_ORG}/`)) {
    return packageName.replace(`@${REGISTRY_ORG}/`, '');
  } else if (packageName.startsWith('@elizaos/')) {
    return packageName.replace(/^@elizaos\//, '');
  }
  return packageName;
}

interface PluginMetadata {
  name: string;
  description: string;
  author: string;
  repository: string;
  versions: string[];
  latestVersion: string;
  runtimeVersion: string;
  maintainer: string;
  tags?: string[];
  categories?: string[];
}

// Default registry data for offline use or when GitHub is unavailable
const DEFAULT_REGISTRY: Record<string, string> = {
  '@elizaos/plugin-anthropic': 'github:elizaos-plugins/plugin-anthropic',
  '@elizaos/plugin-bootstrap': 'github:elizaos-plugins/plugin-bootstrap',
  '@elizaos/plugin-browser': 'github:elizaos-plugins/plugin-browser',
  '@elizaos/plugin-discord': 'github:elizaos-plugins/plugin-discord',
  '@elizaos/plugin-elevenlabs': 'github:elizaos-plugins/plugin-elevenlabs',
  '@elizaos/plugin-evm': 'github:elizaos-plugins/plugin-evm',
  '@elizaos/plugin-farcaster': 'github:elizaos-plugins/plugin-farcaster',
  '@elizaos/plugin-groq': 'github:elizaos-plugins/plugin-groq',
  '@elizaos/plugin-mcp': 'github:elizaos-plugins/plugin-mcp',
  '@elizaos/plugin-messari-ai-toolkit': 'github:messari/plugin-messari-ai-toolkit',
  '@elizaos/plugin-morpheus': 'github:bowtiedbluefin/plugin-morpheus',
  '@elizaos/plugin-node': 'github:elizaos-plugins/plugin-node',
  '@elizaos/plugin-ollama': 'github:elizaos-plugins/plugin-ollama',
  '@elizaos/plugin-openai': 'github:elizaos-plugins/plugin-openai',
  '@elizaos/plugin-pdf': 'github:elizaos-plugins/plugin-pdf',
  '@elizaos/plugin-redpill': 'github:elizaos-plugins/plugin-redpill',
  '@elizaos/plugin-solana': 'github:elizaos-plugins/plugin-solana',
  '@elizaos/plugin-sql': 'github:elizaos-plugins/plugin-sql',
  '@elizaos/plugin-storage-s3': 'github:elizaos-plugins/plugin-storage-s3',
  '@elizaos/plugin-tee': 'github:elizaos-plugins/plugin-tee',
  '@elizaos/plugin-telegram': 'github:elizaos-plugins/plugin-telegram',
  '@elizaos/plugin-twitter': 'github:elizaos-plugins/plugin-twitter',
  '@elizaos/plugin-venice': 'github:elizaos-plugins/plugin-venice',
  '@elizaos/plugin-video-understanding': 'github:elizaos-plugins/plugin-video-understanding',
};

/**
 * Saves the registry index to the cache file
 */
export async function saveRegistryCache(registry: Record<string, string>): Promise<void> {
  try {
    await ensureElizaDir();
    await fs.writeFile(REGISTRY_CACHE_FILE, JSON.stringify(registry, null, 2));
    logger.debug('Registry cache saved successfully');
  } catch (error) {
    logger.debug(
      `Failed to save registry cache: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Gets a local copy of the registry index without requiring GitHub authentication.
 * This is useful for offline mode or when GitHub is unavailable.
 *
 * @returns {Promise<Record<string, string>>} The local registry index
 */
export async function getLocalRegistryIndex(): Promise<Record<string, string>> {
  // First try to fetch from the public raw GitHub URL
  try {
    logger.debug('Fetching registry from public GitHub URL');
    const response = await fetch(RAW_REGISTRY_URL);

    if (response.ok) {
      const rawData = await response.json();

      // Validate the data structure
      const result: Record<string, string> = {};

      if (typeof rawData === 'object' && rawData !== null) {
        // Safely parse the response data
        for (const [key, value] of Object.entries(rawData)) {
          if (typeof value === 'string') {
            result[key] = value;
          }
        }

        // Save the fetched registry to cache for future offline use
        await saveRegistryCache(result);
        logger.debug('Successfully fetched registry from public GitHub URL');
        return result;
      }
    }
  } catch (error) {
    logger.debug(
      `Failed to fetch registry from public URL: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // If fetching fails, try to read from cache
  try {
    if (existsSync(REGISTRY_CACHE_FILE)) {
      const cacheContent = await fs.readFile(REGISTRY_CACHE_FILE, 'utf-8');
      const cachedRegistry = JSON.parse(cacheContent);
      logger.debug('Using cached registry index');
      return cachedRegistry;
    }
  } catch (error) {
    logger.debug(
      `Failed to read registry cache: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // If we're in a monorepo context, try to discover local plugins
  const directoryInfo = detectDirectoryType(process.cwd());
  if (directoryInfo.monorepoRoot) {
    try {
      const localPackages = await getLocalPackages();
      const localRegistry: Record<string, string> = {};

      // getLocalPackages returns an array of package names as strings
      for (const pkgName of localPackages) {
        if (pkgName.includes('plugin-')) {
          // Use the package name as both key and value
          // Format as expected by the registry: orgrepo/packagename
          const repoName = normalizePackageName(pkgName);
          localRegistry[pkgName] = `${REGISTRY_ORG}/${repoName}`;
        }
      }

      // Merge with default registry, prioritizing local packages
      return { ...DEFAULT_REGISTRY, ...localRegistry };
    } catch (error) {
      logger.debug(
        `Failed to discover local plugins: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Fall back to default registry
  return DEFAULT_REGISTRY;
}

/**
 * Fetches the registry index asynchronously.
 *
 * @returns {Promise<Registry>} The registry index
 * @throws {Error} If the response from the registry is not valid JSON or if there is an error fetching the plugins
 */
export async function getRegistryIndex(): Promise<Record<string, string>> {
  const settings = await getRegistrySettings();
  const credentials = await getGitHubCredentials();

  if (!credentials) {
    logger.error('GitHub credentials not found. Please run login first.');
    process.exit(1);
  }

  const [owner, repo] = settings.defaultRegistry.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/index.json`;

  const response = await fetch(url, {
    headers: {
      Authorization: `token ${credentials.token}`,
      Accept: 'application/vnd.github.v3.raw',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch registry index: ${response.statusText}`);
  }

  const data = await response.json();
  if (typeof data !== 'object' || data === null) {
    throw new Error('Invalid registry index format');
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Normalizes a plugin name to the expected format in the registry
 *
 * @param {string} pluginName - The name of the plugin to normalize
 * @returns {string[]} An array of possible normalized plugin names to try
 */
export function normalizePluginName(pluginName: string): string[] {
  // Extract the base name without any organization prefix
  let baseName = pluginName;

  // Handle various input formats
  if (pluginName.includes('/')) {
    // Handle formats like "elizaos/plugin-ton" or "elizaos-plugins/plugin-ton"
    const parts = pluginName.split('/');
    baseName = parts[parts.length - 1];
  } else if (pluginName.startsWith('@')) {
    // Handle scoped package format like "@elizaos/plugin-ton"
    const parts = pluginName.split('/');
    if (parts.length > 1) {
      baseName = parts[1];
    }
  }

  // Remove any existing prefixes
  baseName = baseName.replace(/^plugin-/, '');

  // Generate all possible formats to try (removed duplicates and incorrect namespace)
  return [
    pluginName, // Original input
    baseName, // Just the base name
    `plugin-${baseName}`, // With plugin- prefix
    `@elizaos/${baseName}`, // Scoped with elizaos
    `@elizaos/plugin-${baseName}`, // Scoped with elizaos and plugin prefix
  ];
}

/**
 * Retrieves the repository URL for a given plugin from the registry.
 *
 * @param {string} pluginName - The name of the plugin to fetch the repository URL for.
 * @returns {Promise<string | null>} The repository URL for the plugin, or null if not found.
 * @throws {Error} If an error occurs while retrieving the repository URL.
 */
export async function getPluginRepository(pluginName: string): Promise<string | null> {
  try {
    // Get all possible plugin name formats to try
    const possibleNames = normalizePluginName(pluginName);

    // ONLY try getting from the local/public registry - never use authenticated methods
    const registry = await getLocalRegistryIndex();

    // Try each possible name format in the registry
    for (const name of possibleNames) {
      if (registry[name]) {
        logger.debug(`Found plugin in registry as: ${name}`);
        return registry[name];
      }
    }

    // For scoped packages, try npm directly - NO AUTH REQUIRED
    if (pluginName.startsWith('@')) {
      return pluginName; // Return as-is for npm to handle
    }

    // Direct GitHub shorthand (github:org/repo) - NO AUTH REQUIRED
    if (!pluginName.includes(':') && !pluginName.startsWith('@')) {
      const baseName = pluginName.replace(/^plugin-/, '');
      return `@${REGISTRY_ORG}/plugin-${baseName}`;
    }

    return null;
  } catch (error) {
    logger.debug(
      `Error getting plugin repository: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Check if a GitHub repository has a specific branch
 */
/**
 * Check if a repository has a specific branch.
 *
 * @param {string} repoUrl - The URL of the repository to check.
 * @param {string} branchName - The name of the branch to check for.
 * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the branch exists in the repository.
 */
export async function repoHasBranch(repoUrl: string, branchName: string): Promise<boolean> {
  try {
    const { stdout } = await bunExecSimple('git', ['ls-remote', '--heads', repoUrl, branchName]);
    return stdout.includes(branchName);
  } catch (error) {
    logger.warn(
      `Failed to check for branch ${branchName} in ${repoUrl}: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

export async function getBestBranch(repoUrl: string): Promise<string> {
  // Check for v2 or v2-develop branches
  if (await repoHasBranch(repoUrl, 'v2')) {
    return 'v2';
  }
  if (await repoHasBranch(repoUrl, 'v2-develop')) {
    return 'v2-develop';
  }
  // Default to main branch
  return 'main';
}

export async function listPluginsByType(type?: string): Promise<string[]> {
  const registry = await getRegistryIndex();
  return Object.keys(registry)
    .filter((name) => !type || name.includes(type))
    .sort();
}

export async function getPluginMetadata(pluginName: string): Promise<PluginMetadata | null> {
  const settings = await getRegistrySettings();
  const credentials = await getGitHubCredentials();

  if (!credentials) {
    logger.error('GitHub credentials not found. Please run login first.');
    process.exit(1);
  }

  const [owner, repo] = settings.defaultRegistry.split('/');
  const normalizedName = normalizePackageName(pluginName);
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/packages/${normalizedName}.json`;

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `token ${credentials.token}`,
        Accept: 'application/vnd.github.v3.raw',
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`Failed to fetch plugin metadata: ${response.statusText}`);
    }

    const data = await response.json();
    if (typeof data !== 'object' || data === null) {
      throw new Error('Invalid plugin metadata format');
    }

    const metadata = data as PluginMetadata;
    if (
      !metadata.name ||
      !metadata.description ||
      !metadata.author ||
      !metadata.repository ||
      !metadata.versions ||
      !metadata.latestVersion ||
      !metadata.runtimeVersion ||
      !metadata.maintainer
    ) {
      throw new Error('Invalid plugin metadata: missing required fields');
    }

    return metadata;
  } catch (error) {
    logger.error('Failed to fetch plugin metadata:', error);
    return null;
  }
}

export async function getPluginVersion(
  pluginName: string,
  version?: string
): Promise<string | null> {
  // Skip metadata lookup to avoid auth requirements
  // Just return the requested version or use latest as fallback
  if (version) {
    return version;
  }

  // Try to get package details from non-auth methods
  try {
    const packageDetails = await getPackageDetails(pluginName);
    if (packageDetails?.latestVersion) {
      return packageDetails.latestVersion;
    }
  } catch (error) {
    logger.debug(
      `Error getting package details: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Fallback to a reasonable default version
  return 'latest';
}

export async function getPluginTags(pluginName: string): Promise<string[]> {
  const metadata = await getPluginMetadata(pluginName);
  return metadata?.tags || [];
}

export async function getPluginCategories(pluginName: string): Promise<string[]> {
  const metadata = await getPluginMetadata(pluginName);
  return metadata?.categories || [];
}

export async function getAvailableDatabases(): Promise<string[]> {
  const registry = await getRegistryIndex();
  return Object.keys(registry)
    .filter((name) => name.includes('database-'))
    .sort();
}

/**
 * Attempts to get package details from the registry
 */
export async function getPackageDetails(packageName: string): Promise<{
  name: string;
  description: string;
  author: string;
  repository: string;
  versions: string[];
  latestVersion: string;
  runtimeVersion: string;
  maintainer: string;
} | null> {
  try {
    // Normalize the package name (remove prefix if present)
    const normalizedName = normalizePackageName(packageName);

    // Get package details from registry
    const packageUrl = `${REGISTRY_URL.replace('index.json', '')}packages/${normalizedName}.json`;

    // Use agent only if https_proxy is defined
    const requestOptions: RequestInit = {};
    if (process.env.https_proxy) {
      // @ts-ignore - HttpsProxyAgent is not in the RequestInit type
      requestOptions.agent = new HttpsProxyAgent(process.env.https_proxy);
    }

    const response = await fetch(packageUrl, requestOptions);
    if (response.status !== 200) {
      return null;
    }

    // Get the response body
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      logger.warn(`Invalid JSON response received from registry for package ${packageName}:`, text);
      return null;
    }
  } catch (error) {
    logger.warn(
      `Failed to fetch package details from registry: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Gets the best matching version of a plugin based on runtime version
 */
export async function getBestPluginVersion(
  packageName: string,
  runtimeVersion: string
): Promise<string | null> {
  const packageDetails = await getPackageDetails(packageName);
  if (!packageDetails || !packageDetails.versions || packageDetails.versions.length === 0) {
    return null;
  }

  // If runtime version matches exactly, use the latest version
  if (packageDetails.runtimeVersion === runtimeVersion) {
    return packageDetails.latestVersion;
  }

  // Parse the runtime version for semver matching
  const [runtimeMajor, runtimeMinor] = runtimeVersion.split('.').map(Number);
  const [packageMajor, packageMinor] = packageDetails.runtimeVersion.split('.').map(Number);

  // If major version is different, warn but still return the latest
  if (runtimeMajor !== packageMajor) {
    logger.warn(
      `Plugin ${packageName} was built for runtime v${packageDetails.runtimeVersion}, but you're using v${runtimeVersion}`
    );
    logger.warn('This may cause compatibility issues.');
    return packageDetails.latestVersion;
  }

  // If minor version is different, warn but with less severity
  if (runtimeMinor !== packageMinor) {
    logger.warn(
      `Plugin ${packageName} was built for runtime v${packageDetails.runtimeVersion}, you're using v${runtimeVersion}`
    );
  }

  return packageDetails.latestVersion;
}

export async function checkDataDir(): Promise<DataDirStatus> {
  const status: DataDirStatus = {
    exists: false,
    env: {
      exists: false,
      missingKeys: [...REQUIRED_ENV_VARS],
      hasAllKeys: false,
    },
    settings: {
      exists: false,
      missingKeys: [...REQUIRED_SETTINGS],
      hasAllKeys: false,
    },
  };

  // Check if data directory exists
  try {
    await fs.access(ELIZA_DIR);
    status.exists = true;
  } catch {
    return status;
  }

  // Check .env file
  try {
    const envContent = await fs.readFile(ENV_FILE, 'utf-8');
    const env = dotenv.parse(envContent);
    status.env.exists = true;
    status.env.missingKeys = REQUIRED_ENV_VARS.filter((key) => !env[key]);
    status.env.hasAllKeys = status.env.missingKeys.length === 0;
  } catch {
    // .env file doesn't exist or can't be read
  }

  // Check settings file
  try {
    const settingsContent = await fs.readFile(REGISTRY_SETTINGS_FILE, 'utf-8');
    const settings = JSON.parse(settingsContent);
    status.settings.exists = true;
    status.settings.missingKeys = REQUIRED_SETTINGS.filter((key) => !(key in settings));
    status.settings.hasAllKeys = status.settings.missingKeys.length === 0;
  } catch {
    // settings file doesn't exist or can't be read
  }

  return status;
}

export async function initializeDataDir(): Promise<void> {
  await ensureElizaDir();

  // Initialize .env if it doesn't exist
  try {
    await fs.access(ENV_FILE);
  } catch {
    await fs.writeFile(ENV_FILE, '');
  }

  // Initialize settings if they don't exist
  try {
    await fs.access(REGISTRY_SETTINGS_FILE);
  } catch {
    await saveRegistrySettings({
      defaultRegistry: REGISTRY_REPO,
    });
  }
}

export async function validateDataDir(): Promise<boolean> {
  const status = await checkDataDir();

  if (!status.exists) {
    logger.warn('ElizaOS data directory not found. Initializing...');
    await initializeDataDir();
    return false;
  }

  let isValid = true;

  // Check if GitHub credentials exist - using the same method as getGitHubCredentials
  // This ensures we're checking the same place where credentials are stored
  const envPath = resolveEnvFile();
  if (envPath) {
    const envContent = await fs.readFile(envPath, 'utf-8');
    const parsedEnv = dotenv.parse(envContent);
    if (!parsedEnv.GITHUB_TOKEN) {
      logger.warn('GitHub token not found in environment');
      isValid = false;
    }
  } else {
    logger.warn('.env file not found');
    isValid = false;
  }

  if (!status.env.hasAllKeys) {
    logger.warn(`Missing environment variables: ${status.env.missingKeys.join(', ')}`);
    isValid = false;
  }

  if (!status.settings.exists) {
    logger.warn('Registry settings file not found');
    isValid = false;
  } else if (!status.settings.hasAllKeys) {
    logger.warn(`Missing settings: ${status.settings.missingKeys.join(', ')}`);
    isValid = false;
  }

  return isValid;
}
