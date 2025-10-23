/**
 * Browser and Node.js compatible environment variable abstraction
 * This module provides a unified interface for accessing environment variables
 * that works in both browser and Node.js environments.
 */
/**
 * Type representing the runtime environment
 */
export type RuntimeEnvironment = 'node' | 'browser' | 'unknown';
/**
 * Interface for environment configuration
 */
export interface EnvironmentConfig {
    [key: string]: string | boolean | number | undefined;
}
/**
 * Detect the current runtime environment
 */
export declare function detectEnvironment(): RuntimeEnvironment;
/**
 * Environment abstraction class
 */
declare class Environment {
    private runtime;
    private browserStore?;
    private cache;
    constructor();
    /**
     * Get the current runtime environment
     */
    getRuntime(): RuntimeEnvironment;
    /**
     * Check if running in Node.js
     */
    isNode(): boolean;
    /**
     * Check if running in browser
     */
    isBrowser(): boolean;
    /**
     * Get an environment variable
     */
    get(key: string, defaultValue?: string): string | undefined;
    /**
     * Set an environment variable (mainly for browser/testing)
     */
    set(key: string, value: string | boolean | number): void;
    /**
     * Check if an environment variable exists
     */
    has(key: string): boolean;
    /**
     * Get all environment variables (filtered for safety)
     */
    getAll(): EnvironmentConfig;
    /**
     * Get a boolean environment variable
     */
    getBoolean(key: string, defaultValue?: boolean): boolean;
    /**
     * Get a number environment variable
     */
    getNumber(key: string, defaultValue?: number): number | undefined;
    /**
     * Clear the cache (useful for testing)
     */
    clearCache(): void;
}
/**
 * Get the singleton Environment instance
 */
export declare function getEnvironment(): Environment;
/**
 * Convenience function to get an environment variable
 */
export declare function getEnv(key: string, defaultValue?: string): string | undefined;
/**
 * Convenience function to set an environment variable
 */
export declare function setEnv(key: string, value: string | boolean | number): void;
/**
 * Convenience function to check if an environment variable exists
 */
export declare function hasEnv(key: string): boolean;
/**
 * Convenience function to get a boolean environment variable
 */
export declare function getBooleanEnv(key: string, defaultValue?: boolean): boolean;
/**
 * Convenience function to get a number environment variable
 */
export declare function getNumberEnv(key: string, defaultValue?: number): number | undefined;
/**
 * Initialize browser environment with config
 * This should be called early in browser apps to set up environment
 */
export declare function initBrowserEnvironment(config: EnvironmentConfig): void;
/**
 * Export the current runtime for convenience
 */
export declare const currentRuntime: RuntimeEnvironment;
/**
 * Re-export the Environment class for advanced usage
 */
export { Environment };
/**
 * Find the .env file in the project
 */
export declare function findEnvFile(): string | null;
/**
 * Load environment configuration from .env file
 * Loads environment variables from the project's .env file and returns them as runtime settings.
 * Node.js only - returns empty object in browser.
 */
export declare function loadEnvConfig(envPath?: string): Promise<Record<string, any>>;
//# sourceMappingURL=environment.d.ts.map