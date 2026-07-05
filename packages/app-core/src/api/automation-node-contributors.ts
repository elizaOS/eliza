/**
 * Compatibility re-export for automation catalog contributor registration.
 * The singleton lives in `@elizaos/shared` so plugins can register their own
 * nodes without depending on app-core, while existing app-core import paths
 * keep resolving to the same registry instance.
 */
export * from "@elizaos/shared/automation-node-contributors";
