import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as semver from 'semver';
import { fileURLToPath } from 'node:url';
import { logger } from '@elizaos/core';
import { existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';

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
  name: 'npm' | 'yarn' | 'pnpm' | 'bun' | 'unknown';
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
   * Detects the active package manager
   * @param directory Optional directory to check for lock files. Defaults to process.cwd().
   */
  private async getPackageManagerInfo(directory?: string): Promise<PackageManagerInfo> {
    logger.debug('[UserEnvironment] Detecting package manager');

    const targetDir = directory || process.cwd();
    logger.debug(`[UserEnvironment] Checking for lock files in: ${targetDir}`);

    const isNpx = process.env.npm_execpath?.includes('npx');

    const isBunx = process.argv[0]?.includes('bun');

    // Check for lock files in current directory
    const lockFiles = {
      'bun.lockb': 'bun',
      'pnpm-lock.yaml': 'pnpm',
      'yarn.lock': 'yarn',
      'package-lock.json': 'npm',
    } as const;

    let detectedPM: PackageManagerInfo['name'] = 'unknown';
    let version: string | null = null;

    try {
      // Check lock files in the target directory
      for (const [file, pm] of Object.entries(lockFiles)) {
        if (existsSync(path.join(targetDir, file))) {
          detectedPM = pm as PackageManagerInfo['name'];
          logger.debug(`[UserEnvironment] Detected ${pm} from lock file: ${file}`);
          break;
        }
      }

      // If no lock file found, try environment detection
      if (detectedPM === 'unknown') {
        if (isNpx) detectedPM = 'npm';
        else if (isBunx) detectedPM = 'bun';
        else if (process.env.npm_config_user_agent?.startsWith('pnpm')) detectedPM = 'pnpm';
        else if (process.env.npm_config_user_agent?.startsWith('yarn')) detectedPM = 'yarn';
        else if (process.env.npm_config_user_agent?.startsWith('npm')) detectedPM = 'npm';
      }

      // Try to get version
      if (detectedPM !== 'unknown') {
        try {
          const { stdout } = await import('execa').then(({ execa }) =>
            execa(detectedPM, ['--version'])
          );
          version = stdout.trim();
        } catch (e) {
          logger.debug(
            `[UserEnvironment] Could not get ${detectedPM} version: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    } catch (error) {
      logger.warn(
        `[UserEnvironment] Error detecting package manager: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const packageName = '@elizaos/cli'; // Define package name
    let isGlobalCheck = false;
    try {
      // Check if running via npx/bunx first, as these might trigger global check falsely
      if (!isNpx && !isBunx) {
        // Execute `npm ls -g --depth=0 <packageName>`.
        // If the package is installed globally, the command succeeds (exit code 0).
        // If not, it fails (non-zero exit code), triggering the catch block.
        // Use stdio: 'ignore' to suppress output.
        execSync(`npm ls -g --depth=0 ${packageName}`, { stdio: 'ignore' });
        isGlobalCheck = true;
      }
    } catch (error) {
      // npm ls exits with error if package not found globally
      isGlobalCheck = false;
    }

    // Combine npm check with NODE_ENV check
    const isGlobal = isGlobalCheck || process.env.NODE_ENV === 'global';

    return {
      name: detectedPM,
      version,
      global: isGlobal,
      isNpx,
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
  private findMonorepoRoot(startDir: string): string | null {
    let currentDir = path.resolve(startDir);
    while (true) {
      const corePackagePath = path.join(currentDir, 'packages', 'core');
      if (existsSync(corePackagePath)) {
        // Check if 'packages/core' itself exists and is a directory
        try {
          const stats = statSync(corePackagePath);
          if (stats.isDirectory()) {
            return currentDir; // Found the root containing 'packages/core'
          }
        } catch (e) {
          // Ignore errors like permission denied, continue search
        }
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        // Reached the filesystem root
        return null;
      }
      currentDir = parentDir;
    }
  }

  public async getPathInfo(): Promise<PathInfo> {
    const homedir = os.homedir();
    const elizaDir = path.join(homedir, '.eliza');
    const monorepoRoot = this.findMonorepoRoot(process.cwd());

    logger.debug('[UserEnvironment] Detected monorepo root:', monorepoRoot || 'Not in monorepo');

    return {
      elizaDir,
      envFilePath: path.join(elizaDir, '.env'),
      configPath: path.join(elizaDir, 'config.json'),
      pluginsDir: path.join(elizaDir, 'plugins'),
      monorepoRoot,
      packageJsonPath: path.join(process.cwd(), 'package.json'),
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
      this.getPackageManagerInfo(directory), // Pass directory here
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
        const { execa } = await import('execa');
        const { stdout } = await execa('npm', ['view', packageName, 'version']);
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
