import { bunExecSimple } from './bun-exec';

/**
 * Utility to determine the distribution channel of a version
 */

/**
 * Determine the distribution channel of a version string
 * @param version - The version string to check
 * @returns The channel: 'latest' (stable), 'alpha', or 'beta'
 */
export function getVersionChannel(version: string): 'latest' | 'alpha' | 'beta' {
    // Check for prerelease identifiers
    if (version.includes('-alpha')) return 'alpha';
    if (version.includes('-beta')) return 'beta';

    // No prerelease identifier means it's the latest stable version
    return 'latest';
}

/**
 * Get the latest CLI version for a specific distribution channel
 * @param currentVersion - The current version to determine the channel
 * @returns The latest version if newer than current, or null if already up-to-date
 */
export async function getLatestCliVersionForChannel(currentVersion: string): Promise<string | null> {
    try {
        // Determine the channel of the current version
        const currentChannel = getVersionChannel(currentVersion);

        // Use npm dist-tag to get the latest version for the channel
        const { stdout } = await bunExecSimple('npm', ['view', `@elizaos/cli@${currentChannel}`, 'version']);
        const latestVersion = stdout.trim();

        // Only return if there's a version and it's different from current
        if (latestVersion && latestVersion !== currentVersion) {
            return latestVersion;
        }

        // Already at latest version in this channel
        return null;
    } catch (error) {
        // Log error for debugging - network issues, npm down, etc.
        console.debug('Error checking for CLI updates:', error);
        // Return null to indicate check failed - caller should handle gracefully
        return null;
    }
}
