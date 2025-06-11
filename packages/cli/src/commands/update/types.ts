/**
 * Update command types and interfaces
 */

/**
 * Command options for update operations
 */
export interface UpdateOptions {
  dryRun?: boolean;
  skipBuild?: boolean;
  skipBunMigration?: boolean;
}

/**
 * Global CLI update options
 */
export interface GlobalUpdateOptions {
  version?: string;
  skipBunMigration?: boolean;
}

/**
 * Version comparison result
 */
export interface VersionCheckResult {
  needsUpdate: boolean;
  error?: string;
}

/**
 * Package update information
 */
export interface PackageUpdate {
  current: string;
  latest: string;
}

/**
 * Update check result
 */
export interface UpdateCheckResult {
  hasUpdates: boolean;
  updates: Record<string, PackageUpdate>;
}

/**
 * CLI environment information
 */
export interface CliEnvironment {
  isGlobal: boolean;
  isNpx: boolean;
  isBunx: boolean;
  isNpmInstalled: boolean;
  packageManager: string;
}

/**
 * Update context information
 */
export interface UpdateContext {
  cwd: string;
  isPlugin: boolean;
  directoryInfo: import('@/src/utils/directory-detection').DirectoryInfo;
  environment: CliEnvironment;
}
