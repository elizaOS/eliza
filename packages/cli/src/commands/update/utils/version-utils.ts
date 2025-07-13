import { logger } from '@elizaos/core';
import { bunExecSimple } from '@/src/utils/bun-exec';
import * as semver from 'semver';
import { UserEnvironment } from '@/src/utils/user-environment';
import { VersionCheckResult } from '../types';

// Constants
export const SPECIAL_VERSION_TAGS = ['latest', 'next', 'canary', 'rc', 'dev', 'nightly', 'alpha'];
export const ELIZAOS_ORG = '@elizaos';
export const FALLBACK_VERSION = '0.0.0';

/**
 * Get current CLI version using UserEnvironment
 */
export async function getVersion(): Promise<string> {
  try {
    const envInfo = await UserEnvironment.getInstance().getInfo();
    return envInfo.cli.version;
  } catch (error) {
    logger.error('Error getting CLI version:', error);
    return FALLBACK_VERSION;
  }
}

/**
 * Check if version string is a workspace reference
 */
export const isWorkspaceVersion = (version: string): boolean =>
  version === 'workspace:*' || version === 'workspace' || version.startsWith('workspace:');

/**
 * Check if version is a special tag
 */
export const isSpecialVersionTag = (version: string): boolean =>
  SPECIAL_VERSION_TAGS.includes(version);

/**
 * Version comparison helper
 */
export function checkVersionNeedsUpdate(
  currentVersion: string,
  targetVersion: string
): VersionCheckResult {
  try {
    const cleanCurrent = String(currentVersion).replace(/^[\^~]/, '');

    if (isSpecialVersionTag(cleanCurrent)) {
      return { needsUpdate: true };
    }

    if (!semver.valid(cleanCurrent) && !semver.validRange(cleanCurrent)) {
      return { needsUpdate: false, error: 'Invalid semver format' };
    }

    const versionToCompare = semver.validRange(cleanCurrent)
      ? semver.minVersion(cleanCurrent)?.version || cleanCurrent
      : cleanCurrent;

    return { needsUpdate: semver.lt(versionToCompare, targetVersion) };
  } catch (error) {
    return { needsUpdate: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Check for major version update
 */
export function isMajorUpdate(currentVersion: string, targetVersion: string): boolean {
  try {
    const cleanCurrent = String(currentVersion).replace(/^[\^~]/, '');

    if (isSpecialVersionTag(cleanCurrent) || !semver.valid(cleanCurrent)) {
      return false;
    }

    const currentMajor = semver.major(cleanCurrent);
    const targetMajor = semver.major(targetVersion);
    return targetMajor > currentMajor;
  } catch {
    return false;
  }
}

/**
 * Fetch latest package version from npm registry
 */
export async function fetchLatestVersion(packageName: string): Promise<string | null> {
  try {
    // Always check npm registry for the actual latest version
    const { stdout } = await bunExecSimple('npm', ['view', packageName, 'version'], {
      env: { NODE_ENV: 'production' },
    });
    const version = stdout.trim();
    logger.debug(`Latest version of ${packageName} from npm: ${version}`);
    return version;
  } catch (error) {
    logger.error(
      `Failed to fetch version for ${packageName}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
