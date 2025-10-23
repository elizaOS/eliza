/**
 * Server health check utilities for waiting for servers to be ready
 */
export interface ServerHealthOptions {
    port: number;
    endpoint?: string;
    maxWaitTime?: number;
    pollInterval?: number;
    requestTimeout?: number;
    host?: string;
    protocol?: 'http' | 'https';
}
/**
 * Wait for server to be ready by polling health endpoint
 * @param options - Configuration options for server health check
 */
export declare function waitForServerReady(options: ServerHealthOptions): Promise<void>;
/**
 * Simple ping check for server availability (no stabilization wait)
 * @param options - Configuration options for server ping
 */
export declare function pingServer(options: ServerHealthOptions): Promise<boolean>;
//# sourceMappingURL=server-health.d.ts.map