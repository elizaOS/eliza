/**
 * Network Information API interface
 */
interface NetworkInformation {
    effectiveType: 'slow-2g' | '2g' | '3g' | '4g' | 'unknown';
    saveData: boolean;
    [key: string]: unknown;
}

/**
 * Network status information
 */
export interface NetworkStatus {
    isOffline: boolean;
    effectiveType: 'slow-2g' | '2g' | '3g' | '4g' | 'unknown';
    saveData: boolean;
}

/**
 * Hook that returns the current network status.
 * Utilizes the Network Information API if available.
 * 
 * @returns Network status information including offline state, connection type, and data-saving mode
 */
export function useNetworkStatus(): NetworkStatus {
    // Get navigator.connection if available (Network Information API)
    const connection =
        typeof navigator !== 'undefined' && 'connection' in navigator
            ? (navigator as Navigator & { connection: NetworkInformation }).connection
            : null;

    // Return the effective connection type or a default value
    return {
        isOffline: typeof navigator !== 'undefined' && !navigator.onLine,
        effectiveType: connection?.effectiveType || 'unknown',
        saveData: connection?.saveData || false,
    };
}

