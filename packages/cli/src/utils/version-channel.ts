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
 * @returns The latest version in the same channel, or null if none found
 */
export async function getLatestCliVersionForChannel(currentVersion: string): Promise<string | null> {
    try {
        // Determine the channel of the current version
        const currentChannel = getVersionChannel(currentVersion);

        // Use npm dist-tag to get the latest version for the channel
        const { stdout } = await bunExecSimple('npm', ['view', `@elizaos/cli@${currentChannel}`, 'version']);
        const latestVersion = stdout.trim();

        return latestVersion || null;
    } catch (error) {
        // Log error for debugging
        console.debug('Error checking for CLI updates:', error);
        return null;
    }
}
