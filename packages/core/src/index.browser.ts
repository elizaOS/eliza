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
// Export core modules (all browser-compatible after refactoring)
export * from "./app-route-plugin-registry";
export * from "./build-variant";
export * from "./character";
// `cloud-routing` is pure data (no Node deps) — safe in the browser bundle;
// app-core sensitive-request code depends on `toRuntimeSettings` and route helpers.
export * from "./cloud-routing";
export * from "./connectors";
export * from "./connectors/account-manager";
export * from "./connectors/connector-config";
export * from "./connectors/privacy";
export * from "./database";
export * from "./database/inMemoryAdapter";
export * from "./entities";
export * from "./features/advanced-memory";
export { AutonomyService } from "./features/autonomy/index";
export {
	__setDocumentUrlFetchImplForTests,
	type FetchDocumentFromUrlOptions,
	type FetchedDocumentUrl,
	type FetchedDocumentUrlKind,
	fetchDocumentFromUrl,
	isYouTubeUrl,
} from "./features/documents/index";
export { paymentsPlugin } from "./features/payments/index";
export * from "./lifeops-passive-connectors";
export * from "./logger";
export * from "./memory";
export * from "./prompts";
export * from "./roles";
export * from "./runtime";
export * from "./runtime/context-gates";
export * from "./runtime/context-registry";
export * from "./runtime/conversation-compaction-hook";
export * from "./runtime/execute-planned-tool-call";
export * from "./runtime/rlm";
export * from "./runtime/schema-compat";
export * from "./runtime/sub-planner";
export * from "./runtime/system-prompt";
export * from "./runtime-route-context";
export * from "./sandbox-policy";
// Export schemas (including buildBaseTables for plugin-sql browser/PGLite builds)
export * from "./schemas/character";
export { type BaseTables, buildBaseTables } from "./schemas/index";
export * from "./search";
export * from "./sensitive-request-policy";
export * from "./sensitive-requests";
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
export type { JsonObject, JsonValue } from "./types/primitives";
// Export utils first to avoid circular dependency issues
export * from "./utils";
export { Semaphore } from "./utils/batch-queue/semaphore.js";
export * from "./utils/buffer";
export * from "./utils/description-compressed-lint";
// Export browser-compatible utilities
export * from "./utils/environment";
export { formatError } from "./utils/format-error";
export * from "./utils/read-env";
export * from "./utils/streaming";
export { ResponseSkeletonStreamExtractor } from "./utils/streaming";

function readBrowserEnv(
	env: Record<string, string | undefined> | undefined,
	key: string,
): string | undefined {
	const value = env?.[key]?.trim();
	return value && value.length > 0 ? value : undefined;
}

export function getElizaNamespace(
	env: Record<string, string | undefined> = (
		globalThis as { process?: { env?: Record<string, string | undefined> } }
	).process?.env ?? {},
): string {
	return readBrowserEnv(env, "ELIZA_NAMESPACE") ?? "eliza";
}

export function resolveUserPath(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~/")) return `/${trimmed.slice(2)}`;
	return trimmed;
}

export function resolveStateDir(
	env: Record<string, string | undefined> = (
		globalThis as { process?: { env?: Record<string, string | undefined> } }
	).process?.env ?? {},
): string {
	return (
		readBrowserEnv(env, "ELIZA_STATE_DIR") ?? `/.${getElizaNamespace(env)}`
	);
}

// Browser stubs for Node-only path helpers. These exist on the Node entry
// (see utils/state-dir.ts) and are imported by server-side runtime modules
// (e.g. @elizaos/agent/src/config/paths.ts) that may be statically reached
// by the renderer bundle's dep graph. The values returned are unused in the
// browser; we just need named exports so Rollup's static analysis succeeds.
export function resolveOAuthDir(): string {
	return "/.eliza/oauth";
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

// Cloud-routing helpers (`toRuntimeSettings`, etc.) are pure functions
// used by app-core's sensitive-requests/cloud-link-adapter at static
// import time. Browser-safe — no Node deps — so include them here so
// Rollup can satisfy the named import without falling back to the
// stub plugin.
export * from "./cloud-routing";
