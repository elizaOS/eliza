/**
 * Publishes the content-reference ledger produced by one completed planner turn
 * and binds its current immutable head to the persisted dialogue message. A
 * persistence failure is reported after execution and never replays the turn.
 */
import {
	publishSessionSummaryContentManifests,
	SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY,
} from "../features/advanced-memory/session-summary-content-manifest.ts";
import { deriveCompactionContentManifest } from "../runtime/content-access-manifest.ts";
import type { PlannerTrajectory } from "../runtime/planner-types.ts";
import type { Memory } from "../types/memory.ts";
import type { IAgentRuntime } from "../types/runtime.ts";

export interface PersistMessageContentContinuityParams {
	runtime: IAgentRuntime;
	message: Memory;
	trajectory: Pick<PlannerTrajectory, "steps" | "archivedSteps">;
	lastUsedAt?: string;
}

/** Persist a completed turn's recoverable native references without source bodies. */
export async function persistMessageContentContinuity(
	params: PersistMessageContentContinuityParams,
): Promise<void> {
	try {
		const manifest = deriveCompactionContentManifest(params.trajectory, {
			lastUsedAt: params.lastUsedAt ?? new Date().toISOString(),
		});
		const envelope = await publishSessionSummaryContentManifests({
			runtime: params.runtime,
			roomId: params.message.roomId,
			entityId: params.message.entityId,
			manifests: [manifest],
		});
		if (!envelope || !params.message.id) return;

		// Re-read immediately before the pointer write so independently added
		// message metadata is retained. The immutable room head remains the source
		// of truth; this dialogue pointer makes summary rollover discover it.
		const persisted = await params.runtime.getMemoryById(params.message.id);
		if (!persisted) {
			throw new Error(
				"Dialogue memory disappeared before continuity publication",
			);
		}
		const metadata: Memory["metadata"] = {
			...(persisted.metadata ?? params.message.metadata ?? {}),
			type: "message",
			[SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY]: envelope,
		};
		const updated = await params.runtime.updateMemory({
			id: params.message.id,
			metadata,
		});
		if (!updated) {
			throw new Error("Dialogue continuity pointer was not persisted");
		}
		params.message.metadata = metadata;
	} catch (error) {
		// error-policy:J7 The completed planner turn and its effects must not be
		// replayed when post-execution continuity persistence fails.
		params.runtime.reportError("MessageService.persistContentManifest", error, {
			messageId: params.message.id,
			roomId: params.message.roomId,
		});
		params.runtime.logger?.warn?.(
			{
				err: error,
				messageId: params.message.id,
				roomId: params.message.roomId,
			},
			"[message] failed to persist planner content continuity",
		);
	}
}
