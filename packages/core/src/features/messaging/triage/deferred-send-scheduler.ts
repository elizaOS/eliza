/**
 * Runtime-scoped port from core messaging into the durable ScheduledTask host.
 *
 * Core cannot depend on a plugin, so the always-loaded scheduling host (or its
 * LifeOps driver) registers this port during runtime initialization. The port
 * persists the complete draft snapshot; a connector's process-local draft
 * cache is never treated as restart-safe state.
 */

import { ElizaError } from "../../../errors.ts";
import type { IAgentRuntime } from "../../../types/index.ts";
import type { DraftRecord } from "./types.ts";

export type DeferredMessageScheduleCommit = {
	kind: "durable" | "provider_accepted";
	id: string;
	committedAt: string;
	idempotencyKey: string;
	replayed: boolean;
};

export interface DeferredMessageScheduleRequest {
	draft: DraftRecord;
	sendAtMs: number;
}

export interface DeferredMessageScheduleResult {
	scheduledId: string;
	scheduledForMs: number;
	commit: DeferredMessageScheduleCommit;
}

export interface DeferredMessageScheduler {
	schedule(
		request: DeferredMessageScheduleRequest,
	): Promise<DeferredMessageScheduleResult>;
}

const schedulers = new WeakMap<IAgentRuntime, DeferredMessageScheduler>();

/**
 * Install the one durable deferred-message scheduler for a runtime.
 *
 * Duplicate registration is a wiring error: silently replacing the scheduler
 * could strand rows in a store owned by the previous implementation.
 */
export function registerDeferredMessageScheduler(
	runtime: IAgentRuntime,
	scheduler: DeferredMessageScheduler,
): () => void {
	if (schedulers.has(runtime)) {
		throw new ElizaError(
			"A deferred-message scheduler is already registered for this runtime.",
			{
				code: "DEFERRED_MESSAGE_SCHEDULER_DUPLICATE",
				severity: "fatal",
			},
		);
	}
	schedulers.set(runtime, scheduler);
	return () => {
		if (schedulers.get(runtime) === scheduler) {
			schedulers.delete(runtime);
		}
	};
}

export function getDeferredMessageScheduler(
	runtime: IAgentRuntime,
): DeferredMessageScheduler | null {
	return schedulers.get(runtime) ?? null;
}
