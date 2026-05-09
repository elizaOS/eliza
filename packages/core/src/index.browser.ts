/**
 * Browser-specific entry point for @elizaos/core
 *
 * This file exports only browser-compatible modules and provides
 * stubs or alternatives for Node.js-specific functionality.
 * Streaming context manager is auto-detected at runtime.
 */

export * from "./actions";
export * from "./api/http-helpers";
export * from "./api/route-helpers";
export * from "./app-registry";
// Export core modules (all browser-compatible after refactoring)
export * from "./app-route-plugin-registry";
export * from "./character";
export * from "./connectors";
export * from "./connectors/account-manager";
export * from "./connectors/privacy";
export * from "./database";
export * from "./database/inMemoryAdapter";
export * from "./entities";
export * from "./features/advanced-memory";
export { AutonomyService } from "./features/autonomy/index";
export { createBasicCapabilitiesPlugin } from "./features/basic-capabilities/index";
export {
	__setDocumentUrlFetchImplForTests,
	type FetchDocumentFromUrlOptions,
	type FetchedDocumentUrl,
	type FetchedDocumentUrlKind,
	fetchDocumentFromUrl,
	isYouTubeUrl,
} from "./features/documents/index";
export * from "./lifeops-passive-connectors";
export * from "./logger";
export * from "./memory";
export * from "./prompts";
export * from "./roles";
export * from "./runtime";
export * from "./runtime/context-gates";
export * from "./runtime/context-registry";
export * from "./runtime/execute-planned-tool-call";
export * from "./runtime/schema-compat";
export * from "./runtime/sub-planner";
export * from "./runtime/system-prompt";
export * from "./runtime-route-context";
// Export schemas (including buildBaseTables for plugin-sql browser/PGLite builds)
export * from "./schemas/character";
export { type BaseTables, buildBaseTables } from "./schemas/index";
export * from "./search";
export * from "./services";
export * from "./services/agentEvent";
// Server/runtime entry points also register these; the browser bundle must
// expose the same symbols so Vite/esbuild can statically resolve plugins that
// list them in `services` (see @elizaos/agent runtime).
export { AgentEventService } from "./services/agentEvent";
export * from "./services/message";
export * from "./services/trajectories";
export * from "./settings";
export * from "./streaming-context";
export * from "./trajectory-context";
export * from "./trajectory-utils";
export type { ConnectorAccountCapability, ConnectorAccountRef } from "./types";
// Export everything from types (type-only, safe for browser)
export * from "./types";
export {
	ConnectorAccountHealth,
	ConnectorAccountPurpose,
	ConnectorAccountRole,
	ConnectorAuthMethod,
} from "./types";
export * from "./types/message-service";
export type { JsonObject, JsonValue } from "./types/proto";
// Keep proto JSON helpers as explicit runtime exports so browser plugin
// bundles don't depend on Bun preserving the ./types barrel namespace export.
export * as proto from "./types/proto";
// Export utils first to avoid circular dependency issues
export * from "./utils";
export { Semaphore } from "./utils/batch-queue/semaphore.js";
export * from "./utils/buffer";
export * from "./utils/description-compressed-lint";
// Export browser-compatible utilities
export * from "./utils/environment";

export function resolveStateDir(): string {
	return "/.eliza";
}

export async function runPluginMigrations(): Promise<void> {}

// Browser-specific exports or stubs for Node-only features
export const isBrowser = true;
export const isNode = false;

/**
 * Browser stub for server health checks
 * In browser environment, this is a no-op
 */
export const serverHealth = {
	check: async () => ({ status: "not-applicable", environment: "browser" }),
	isHealthy: () => true,
};
