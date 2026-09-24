/**
 * Compatibility re-export for automation catalog contributor registration.
 * The singleton lives in `@elizaos/shared` so plugins can register their own
 * nodes without depending on app, while existing app import paths
 * keep resolving to the same registry instance.
 */
export * from "@elizaos/core/automation-node-contributors";
