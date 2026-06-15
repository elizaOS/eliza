/**
 * ApprovalQueue — queue of outbound sends that require explicit owner approval
 * before the connector dispatches them. Features that produce
 * approval-requiring payloads (drafts, expensive actions, sensitive messages)
 * enqueue here; the owner-facing approval UI dequeues and resolves entries.
 *
 * STUB — see this directory's README for the tracked migration.
 *
 * TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/approval-queue ->
 *               packages/app-core/src/dispatch/approval-queue.ts)
 */

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalEntry {
	readonly id: string;
	/** Free-form caller tag — which feature enqueued this entry. */
	readonly origin: string;
	/** Owner-facing summary the approval UI renders. */
	readonly summary: string;
	/** Opaque payload the resolver hands back to the originator. */
	readonly payload: unknown;
	readonly status: ApprovalStatus;
	readonly createdAt: string;
	readonly resolvedAt?: string;
}

export interface ApprovalQueue {
	enqueue(
		entry: Omit<ApprovalEntry, "status" | "createdAt" | "resolvedAt">,
	): Promise<void>;
	listPending(): Promise<readonly ApprovalEntry[]>;
	resolve(
		id: string,
		decision: "approved" | "rejected",
	): Promise<ApprovalEntry>;
	expire(id: string): Promise<void>;
}

export class StubApprovalQueue implements ApprovalQueue {
	async enqueue(
		_entry: Omit<ApprovalEntry, "status" | "createdAt" | "resolvedAt">,
	): Promise<void> {
		throw new Error(
			"[StubApprovalQueue] not implemented — see packages/app-core/src/dispatch/README.md",
		);
	}

	async listPending(): Promise<readonly ApprovalEntry[]> {
		throw new Error(
			"[StubApprovalQueue] not implemented — see packages/app-core/src/dispatch/README.md",
		);
	}

	async resolve(
		_id: string,
		_decision: "approved" | "rejected",
	): Promise<ApprovalEntry> {
		throw new Error(
			"[StubApprovalQueue] not implemented — see packages/app-core/src/dispatch/README.md",
		);
	}

	async expire(_id: string): Promise<void> {
		throw new Error(
			"[StubApprovalQueue] not implemented — see packages/app-core/src/dispatch/README.md",
		);
	}
}
