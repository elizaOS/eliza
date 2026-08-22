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

export {
	ElizaError,
	type ElizaErrorOptions,
	type ElizaErrorSeverity,
	isElizaError,
	type ReportedError,
	toElizaError,
} from "./errors";
// Re-export everything from the Node.js entry point
// This ensures that imports from "@elizaos/core" resolve correctly during builds
export * from "./index.node";
// Unwraps the untrusted-content envelope to the user's verbatim text. Public
// because orchestration surfaces that forward a user message onward (e.g. a
// deterministic follow-up send) must never embed the security banner in a
// child task (live 2026-08-21: a sub-agent echoed the banner back and the
// outbound envelope guard blocked its completion).
export { extractWrappedExternalContent } from "./security/external-content";
export {
	isSensitiveKeyName,
	redactLogArgs,
	redactObjectSecrets,
	redactSecrets,
	redactSensitiveText,
} from "./security/redact";
