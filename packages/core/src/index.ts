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

// Phase 5A transition shim: keep non-overlapping type contracts available from
// @elizaos/core while consumers migrate to @elizaos/contracts. The full
// contracts barrel overlaps with long-standing core exports, so keep this list
// explicit to avoid declaration-generation ambiguity.
export type {
	CharacterLanguage,
	DeploymentTargetRuntime,
	ElizaCloudService,
	MessageExampleContent,
	ResolvedElizaCloudTopology,
} from "@elizaos/contracts";
// Re-export everything from the Node.js entry point
// This ensures that imports from "@elizaos/core" resolve correctly during builds
export * from "./index.node";
