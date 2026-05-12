/**
 * Pure composition layer for the `bootProgress` typed RPC.
 *
 * Two halves:
 *   - `readAgentHealthSnapshot`  : transitional carrier that wraps an
 *     in-process HTTP fetch against the agent child's `/api/health`.
 *     Swaps to a direct in-process read once the agent runtime merges
 *     into the Bun process; the BootProgressSnapshot contract is
 *     unchanged through that migration.
 *   - `composeBootProgressSnapshot` : takes the agent status (from
 *     AgentManager.getStatus) and a health-snapshot reader. No module
 *     singletons here — everything is injected. The handler in
 *     `rpc-handlers.ts` wires this up to `getAgentManager()` + the real
 *     fetch reader.
 */

import type { BootProgressSnapshot, EmbeddedAgentStatus } from "./rpc-schema";

export type AgentHealthSnapshot = Pick<
	BootProgressSnapshot,
	"phase" | "lastError" | "pluginsLoaded" | "pluginsFailed" | "database"
>;

export type AgentHealthReader = (port: number) => Promise<AgentHealthSnapshot | null>;

/** Default reader: in-process HTTP fetch against the agent child's /api/health. */
export const readAgentHealthSnapshotViaHttp: AgentHealthReader = async (
	port: number,
): Promise<AgentHealthSnapshot | null> => {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
			method: "GET",
			signal: AbortSignal.timeout(2_000),
		});
		if (!response.ok) return null;
		const raw = (await response.json()) as {
			database?: unknown;
			plugins?: { loaded?: unknown; failed?: unknown };
			startup?: { phase?: unknown; lastError?: unknown };
		};
		const phaseRaw = raw.startup?.phase;
		const lastErrorRaw = raw.startup?.lastError;
		const loadedRaw = raw.plugins?.loaded;
		const failedRaw = raw.plugins?.failed;
		const databaseRaw = raw.database;
		return {
			phase: typeof phaseRaw === "string" ? phaseRaw : null,
			lastError: typeof lastErrorRaw === "string" ? lastErrorRaw : null,
			pluginsLoaded: typeof loadedRaw === "number" ? loadedRaw : null,
			pluginsFailed: typeof failedRaw === "number" ? failedRaw : null,
			database:
				databaseRaw === "ok" ||
				databaseRaw === "unknown" ||
				databaseRaw === "error"
					? databaseRaw
					: null,
		};
	} catch {
		// Pre-listen, mid-restart, or timeout. Caller fills with `null`s.
		return null;
	}
};

/**
 * Compose the typed BootProgressSnapshot from the agent's lifecycle
 * status plus an injected health reader. Pure — no module singletons,
 * no side effects beyond the reader call.
 */
export async function composeBootProgressSnapshot(
	status: EmbeddedAgentStatus,
	readHealth: AgentHealthReader,
	now: () => Date = () => new Date(),
): Promise<BootProgressSnapshot> {
	const port = status.port;
	const health = port !== null ? await readHealth(port) : null;
	return {
		state: status.state,
		phase: health?.phase ?? null,
		lastError: health?.lastError ?? status.error ?? null,
		pluginsLoaded: health?.pluginsLoaded ?? null,
		pluginsFailed: health?.pluginsFailed ?? null,
		database: health?.database ?? null,
		agentName: status.agentName,
		port,
		startedAt: status.startedAt,
		updatedAt: now().toISOString(),
	};
}
