/**
 * Main entry point for @elizaos/core
 *
 * This is the default export that includes all modules.
 * The build system creates separate bundles for Node.js and browser environments.
 * Package.json conditional exports handle the routing to the correct build.
 *
 * This file re-exports from index.node.ts to ensure source-level imports work
 * correctly during builds when bundlers resolve against source files.
 */

// Re-export everything from the Node.js entry point
// This ensures that imports from "@elizaos/core" resolve correctly during builds
export * from "./index.node";

// Phase 5A transition shim: re-export type contracts from @elizaos/contracts so
// consumers migrating off `@elizaos/core` keep working while imports are moved
// over to the dedicated types-only package. Duplicate names from `./index.node`
// take precedence; `export type *` silently excludes overlapping identifiers.
export type * from "@elizaos/contracts";
