import type { IAgentRuntime } from "../../../types/index.ts";

/**
 * Minimal Drizzle-compatible DB interface.
 * Uses a chainable query builder pattern matching drizzle-orm.
 */
// biome-ignore lint/suspicious/noExplicitAny: Drizzle's fluent API requires `any` return for chainable query builders
export type DrizzleDB = Record<string, (...args: unknown[]) => any>;

/**
 * Get the Drizzle database instance from the runtime.
 * @throws if the database is unavailable.
 */
export function getDb(runtime: IAgentRuntime): DrizzleDB {
	const db = runtime.db as DrizzleDB | undefined;
	if (!db) throw new Error("[trust] Database not available");
	return db;
}
