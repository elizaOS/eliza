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
