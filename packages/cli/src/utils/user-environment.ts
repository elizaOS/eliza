import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as semver from 'semver';
import { fileURLToPath } from 'node:url';
import { logger } from '@elizaos/core';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolveEnvFile } from './resolve-utils';
import { emoji } from './emoji-handler';
import { autoInstallBun, shouldAutoInstall } from './auto-install-bun';
import { bunExecSimple } from './bun-exec';

// Types
interface OSInfo {
  platform: string;
  release: string;
  arch: string;
  type: string;
  version: string;
  homedir: string;
}

interface CLIInfo {
  version: string;
  name: string;
  path: string;
}

interface PackageManagerInfo {
  name: 'bun';
  version: string | null;
  global: boolean;
  isNpx: boolean;
  isBunx: boolean;
}

interface PathInfo {
  elizaDir: string;
  envFilePath: string;
  configPath: string;
  pluginsDir: string;
  monorepoRoot: string | null;
  packageJsonPath: string;
}

interface EnvInfo {
  GITHUB_USERNAME?: string;
  GITHUB_TOKEN?: string;
  [key: string]: string | undefined;
}

export interface UserEnvironmentInfo {
  os: OSInfo;
  cli: CLIInfo;
  packageManager: PackageManagerInfo;
  timestamp: string;
  paths: PathInfo;
  env: EnvInfo;
}

/**
 * Provides information about the user's environment including OS, CLI, and package manager details.
 * Uses singleton pattern to cache results.
 */
export class UserEnvironment {
  public static readonly getInstance = () => UserEnvironment.instance;

  public static readonly getInstanceInfo = () => UserEnvironment.instance.getInfo();

  private static readonly instance: UserEnvironment = new UserEnvironment();
  private cachedInfo: { [key: string]: UserEnvironmentInfo } = {}; // Cache per directory

  private constructor() {}

  /**
   * Gets operating system information
   */
  private async getOSInfo(): Promise<OSInfo> {
    logger.debug('[UserEnvironment] Detecting OS information');
    return {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      type: os.type(),
      version: os.version(),
      homedir: os.homedir(),
    };
  }

  /**
   * Gets CLI version and package information
   */
  private async getCLIInfo(): Promise<CLIInfo> {
    logger.debug('[UserEnvironment] Getting CLI information');
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const packageJsonPath = path.resolve(__dirname, '../package.json');

      if (!existsSync(packageJsonPath)) {
        throw new Error(`CLI package.json not found at ${packageJsonPath}`);
      }

      const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(packageJsonContent);

      return {
        version: packageJson.version || '0.0.0',
        name: packageJson.name || '@elizaos/cli',
        path: process.argv[1] || '',
      };
    } catch (error) {
      logger.warn(
        `[UserEnvironment] Error getting CLI info: ${error instanceof Error ? error.message : String(error)}`
      );
      return {
        version: '0.0.0',
        name: '@elizaos/cli',
        path: process.argv[1] || '',
      };
    }
  }

  /**
   * Detects the active package manager - always returns bun for ElizaOS CLI
   */
  private async getPackageManagerInfo(): Promise<PackageManagerInfo> {
    logger.debug('[UserEnvironment] Using bun as the package manager for ElizaOS CLI');

    const isNpx = process.env.npm_execpath?.includes('npx');
    // Check if running via bunx by looking for bunx cache patterns in the script path
    const scriptPath = process.argv[1] || '';
    const isBunx =
      scriptPath.includes('.bun/install/cache/') ||
      scriptPath.includes('bunx') ||
      process.env.BUN_INSTALL_CACHE_DIR !== undefined;

    let version: string | null = null;

    // First check if we're already running under Bun
    if (typeof Bun !== 'undefined' && Bun.version) {
      version = Bun.version;
      logger.debug(`[UserEnvironment] Running under Bun runtime, version: ${version}`);
    } else {
      try {
        // Get bun version from command line
        const { stdout } = await bunExecSimple('bun', ['--version']);
        version = stdout.trim();
        logger.debug(`[UserEnvironment] Bun version: ${version}`);
      } catch (e) {
        logger.debug(
          `[UserEnvironment] Could not get bun version: ${e instanceof Error ? e.message : String(e)}`
        );

        // Attempt auto-installation if conditions are met
        if (shouldAutoInstall()) {
          logger.info(`${emoji.info('Attempting to automatically install Bun...')}`);
          const installSuccess = await autoInstallBun();

          if (installSuccess) {
            // Try to get version again after installation
            try {
              const { stdout } = await bunExecSimple('bun', ['--version']);
              version = stdout.trim();
              logger.debug(`[UserEnvironment] Bun version after auto-install: ${version}`);
            } catch (retryError) {
              logger.error(
                `Failed to verify Bun installation after auto-install: ${
                  retryError instanceof Error ? retryError.message : String(retryError)
                }`
              );
              // Continue to manual installation instructions
            }
          }
        }

        // If auto-installation failed or was not attempted, show manual instructions
        if (!version) {
          const platform = process.platform;
          logger.error(
            `${emoji.error('Bun is required for ElizaOS CLI but is not installed or not found in PATH.')}`
          );
          logger.error('');
          logger.error(
            `${emoji.rocket('Install Bun using the appropriate command for your system:')}`
          );
          logger.error('');

          if (platform === 'win32') {
            logger.error('   Windows: powershell -c "irm bun.sh/install.ps1 | iex"');
          } else {
            logger.error('   Linux/macOS: curl -fsSL https://bun.sh/install | bash');
            if (platform === 'darwin') {
              logger.error('   macOS (Homebrew): brew install bun');
            }
          }
          logger.error('');
          logger.error('   More options: https://bun.sh/docs/installation');
          logger.error('   After installation, restart your terminal or source your shell profile');
          logger.error('');

          // Force exit the process - Bun is required for ElizaOS CLI
          logger.error('🔴 Exiting: Bun installation is required to continue.');
          process.exit(1);
        }
      }
    }

    const packageName = '@elizaos/cli';
    let isGlobalCheck = false;

    // First check if the script path indicates a global installation
    const cliPath = process.argv[1] || '';
    const isInGlobalPath =
      cliPath.includes('/.bun/install/global/') ||
      cliPath.includes('/npm/global/') ||
      (process.platform === 'win32' && cliPath.includes('\\npm\\'));

    try {
      // Check if running via npx/bunx first, as these might trigger global check falsely
      if (!isNpx && !isBunx) {
        // If we're already in a global path, consider it global
        if (isInGlobalPath) {
          isGlobalCheck = true;
        } else {
          // Check if bun has the CLI installed globally
          // Use Bun.spawnSync for checking global packages
          const args =
            process.platform === 'win32'
              ? ['cmd', '/c', `bun pm ls -g | findstr "${packageName}"`]
              : ['sh', '-c', `bun pm ls -g | grep -q "${packageName}"`];

          const proc = Bun.spawnSync(args, {
            stdout: 'ignore',
            stderr: 'ignore',
          });

          isGlobalCheck = proc.exitCode === 0;
        }
      }
    } catch (error) {
      // Package not found globally - but still might be global based on path
      isGlobalCheck = isInGlobalPath;
    }

    // Combine check with NODE_ENV check
    const isGlobal = isGlobalCheck || process.env.NODE_ENV === 'global';

    return {
      name: 'bun',
      version,
      global: isGlobal,
      isNpx: !!isNpx,
      isBunx,
    };
  }

  /**
   * Finds the monorepo root by traversing upwards from a starting directory,
   * looking for a marker directory ('packages/core').
   *
   * @param startDir The directory to start searching from.
   * @returns The path to the monorepo root if found, otherwise null.
   */
  public findMonorepoRoot(startDir: string): string | null {
    let currentDir = path.resolve(startDir);
    let levels = 0;
    const MAX_LEVELS = 10; // Limit traversal to prevent excessive filesystem searching

    while (levels < MAX_LEVELS) {
      const corePackagePath = path.join(currentDir, 'packages', 'core');
      if (existsSync(corePackagePath)) {
        try {
          const stats = statSync(corePackagePath);
          if (stats.isDirectory()) {
            // Additional validation: check if this looks like the ElizaOS monorepo
            const packageJsonPath = path.join(currentDir, 'package.json');
            if (existsSync(packageJsonPath)) {
              const packageJsonContent = readFileSync(packageJsonPath, 'utf8');
              const packageJson = JSON.parse(packageJsonContent);
              // Verify this is actually the ElizaOS monorepo
              if (packageJson.name?.includes('eliza') || packageJson.workspaces) {
                return currentDir;
              }
            }
          }
        } catch (e) {
          // Ignore errors like permission denied, continue search
        }
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        // Reached filesystem root
        return null;
      }
      currentDir = parentDir;
      levels++;
    }

    // Reached max levels
    return null;
  }

  public async getPathInfo(): Promise<PathInfo> {
    const monorepoRoot = this.findMonorepoRoot(process.cwd());
    const projectRootForPaths = monorepoRoot || process.cwd();
    const elizaDir = path.join(projectRootForPaths, '.eliza');

    // Resolve .env from current working directory up to monorepo root (if any), or only cwd if not in monorepo
    const envFilePath = resolveEnvFile(process.cwd(), monorepoRoot ?? undefined);

    logger.debug('[UserEnvironment] Detected monorepo root:', monorepoRoot || 'Not in monorepo');

    return {
      elizaDir,
      envFilePath,
      configPath: path.join(elizaDir, 'config.json'),
      pluginsDir: path.join(elizaDir, 'plugins'),
      monorepoRoot,
      packageJsonPath: path.join(projectRootForPaths, 'package.json'),
    };
  }

  private async getEnvInfo(): Promise<EnvInfo> {
    // Return a copy of process.env as EnvInfo
    return { ...process.env } as EnvInfo;
  }

  public async getInfo(directory?: string): Promise<UserEnvironmentInfo> {
    const cacheKey = directory || 'cwd'; // Use directory or 'cwd' as cache key

    if (this.cachedInfo[cacheKey]) {
      return this.cachedInfo[cacheKey];
    }

    logger.debug(`[UserEnvironment] Gathering environment information for directory: ${cacheKey}`);

    const [os, cli, packageManager, paths, env] = await Promise.all([
      this.getOSInfo(),
      this.getCLIInfo(),
      this.getPackageManagerInfo(),
      this.getPathInfo(),
      this.getEnvInfo(),
    ]);

    const info = {
      os,
      cli,
      packageManager,
      timestamp: new Date().toISOString(),
      paths,
      env,
    };

    this.cachedInfo[cacheKey] = info; // Store info using cache key

    return info;
  }

  /**
   * Clears the cached information
   */
  public clearCache(): void {
    this.cachedInfo = {};
  }

  /**
   * Gets the version of a specified package from monorepo, local dependencies, or npm
   */
  public async getPackageVersion(packageName: string): Promise<string> {
    try {
      const { monorepoRoot } = await this.getPathInfo();

      // Try monorepo first if available
      if (monorepoRoot) {
        const monoRepoPackagePath = path.join(
          monorepoRoot,
          'packages',
          packageName.replace('@elizaos/', ''),
          'package.json'
        );

        if (existsSync(monoRepoPackagePath)) {
          const packageJson = JSON.parse(await fs.readFile(monoRepoPackagePath, 'utf8'));
          if (packageJson.version) return packageJson.version;
        }
      }

      // Check CLI package dependencies
      const cliInfo = await this.getCLIInfo();
      const cliDir = path.dirname(cliInfo.path);
      const cliPackagePath = path.join(cliDir, 'package.json');

      if (existsSync(cliPackagePath)) {
        const packageJson = JSON.parse(await fs.readFile(cliPackagePath, 'utf8'));
        const versionRange = packageJson.dependencies?.[packageName];
        if (versionRange) {
          const minVer = semver.minVersion(versionRange);
          if (minVer) {
            return minVer.version; // Use the parsed minimum version
          } else {
            logger.warn(
              `Could not parse semver range '${versionRange}' for package ${packageName}. Falling back to original string.`
            );
            return versionRange; // Fallback to original string if parsing fails
          }
        }
      }

      // Try npm as last resort
      try {
        const { stdout } = await bunExecSimple('npm', ['view', packageName, 'version']);
        if (stdout?.trim()) {
          logger.info(`Found latest version of ${packageName} from npm: ${stdout.trim()}`);
          return stdout.trim();
        }
      } catch (npmError) {
        logger.warn(`Could not get latest version from npm: ${npmError}`);
      }

      return '0.25.9'; // Default fallback
    } catch (error) {
      logger.warn(`Error getting package version for ${packageName}: ${error}`);
      return '0.25.9';
    }
  }

  /**
   * Get local packages available in the monorepo
   */
  public async getLocalPackages(): Promise<string[]> {
    const { monorepoRoot } = await this.getPathInfo();
    if (!monorepoRoot) return [];

    try {
      const packagesDirEntries = await fs.readdir(path.join(monorepoRoot, 'packages'), {
        withFileTypes: true,
      });

      const pluginPackages = packagesDirEntries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('plugin-'))
        .map((entry) => `@elizaos/${entry.name}`);

      return pluginPackages;
    } catch (error) {
      logger.warn(`Error getting local packages: ${error}`);
      return [];
    }
  }
}
