/**
 * Turn-time revision guard for deferred fact writes. A post-turn write phase
 * that runs after later turns were admitted stamps its rows with the instant
 * its own turn ended (`baselineMs`) and refuses to modify a fact whose last
 * write is newer than that instant: such state belongs to a later turn (a
 * foreground action or a later evaluator) and an older extraction must not
 * overwrite it. New facts still land, stamped with the baseline so recency
 * follows turn order rather than apply order. Without a baseline (write phase
 * inside the turn's own room lane) writes proceed unguarded and stamp now.
 */
import { logger } from "../../../logger.ts";
import type { IAgentRuntime, Memory } from "../../../types/index.ts";

export interface FactWriteClock {
	baselineMs?: number;
}

export function factWriteNowMs(clock: FactWriteClock | undefined): number {
	return clock?.baselineMs ?? Date.now();
}

export function factWriteNowIso(clock: FactWriteClock | undefined): string {
	return new Date(factWriteNowMs(clock)).toISOString();
}

function isoToMs(value: unknown): number {
	if (typeof value !== "string") return 0;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : 0;
}

/** Newest write recorded on a fact: creation, confirmation, or a guarded update. */
export function factLastWriteMs(fact: Memory): number {
	const meta = (fact.metadata ?? {}) as Record<string, unknown>;
	return Math.max(
		typeof fact.createdAt === "number" ? fact.createdAt : 0,
		isoToMs(meta.lastConfirmedAt),
		isoToMs(meta.updatedAt),
	);
}

/**
 * The fact to mutate, re-read immediately before the write when a baseline is
 * set. Null when the fact is gone or when a later turn wrote it after this
 * turn's baseline; the caller skips its write. Without a baseline the
 * snapshot is returned as is.
 */
export async function loadFactForWrite(
	runtime: IAgentRuntime,
	snapshot: Memory,
	clock: FactWriteClock | undefined,
	scope: string,
): Promise<Memory | null> {
	if (!snapshot.id) return null;
	const baselineMs = clock?.baselineMs;
	if (baselineMs === undefined) return snapshot;
	const current = await runtime.getMemoryById(snapshot.id);
	if (!current) {
		logger.debug(
			{ src: scope, factId: snapshot.id, baselineMs },
			"Skipping deferred fact write; the fact no longer exists",
		);
		return null;
	}
	const lastWriteMs = factLastWriteMs(current);
	if (lastWriteMs > baselineMs) {
		logger.debug(
			{ src: scope, factId: snapshot.id, baselineMs, lastWriteMs },
			"Skipping stale deferred fact write; a later turn already updated this fact",
		);
		return null;
	}
	return current;
}
