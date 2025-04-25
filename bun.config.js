/**
 * Bun configuration for workspace resolution
 * 
 * This configuration improves dependency resolution in workspaces
 * with better handling of local packages.
 */
export default {
    // Explicitly define workspaces
    workspaces: ["packages/*"],

    // Configure package linking to prioritize workspace packages
    install: {
        // Force use of exact workspace paths for internal dependencies
        exact: true,
        // Ensure workspace packages take precedence over registry packages
        priority: "workspace",
        // Increase timeout for package resolution
        timeout: 600000,
        // Retry failed installs
        retries: 5,
        // Cache configuration 
        cache: false,
        // Log level
        logLevel: "debug"
    },

    // Turn on debug output
    debug: true,

    // Registry configuration
    registry: {
        // Ensure registry requests are given enough time
        timeout: 300000
    }
}; 