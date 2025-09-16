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

        // Get the time data for all published versions to find the most recent
        const { stdout } = await bunExecSimple('npm', ['view', '@elizaos/cli', 'time', '--json']);
        const timeData = JSON.parse(stdout);

        // Remove metadata entries like 'created' and 'modified'
        delete timeData.created;
        delete timeData.modified;

        // Filter versions by channel and find the most recently published version
        let latestVersion = '';
        let latestDate = new Date(0); // Start with epoch time

        for (const [version, dateString] of Object.entries(timeData)) {
            // Skip versions from different channels
            if (getVersionChannel(version) !== currentChannel) {
                continue;
            }

            const publishDate = new Date(dateString as string);
            if (publishDate > latestDate) {
                latestDate = publishDate;
                latestVersion = version;
            }
        }

        return latestVersion || null;
    } catch (error) {
        // Log error for debugging
        console.debug('Error checking for CLI updates:', error);
        return null;
    }
}
