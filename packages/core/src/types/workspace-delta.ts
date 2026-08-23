/**
 * Typed, content-free observations of net workspace changes made by a tool.
 * Receipts live under the canonical ActionResult.data key so existing action,
 * streaming, trajectory, and planner transports preserve them unchanged.
 */

/** Canonical ActionResult.data key for a workspace delta observation. */
export const WORKSPACE_DELTA_RECEIPT_DATA_KEY =
	"workspaceDeltaReceipt" as const;

export type WorkspaceDeltaOutcome = "changed" | "unchanged" | "indeterminate";

export interface WorkspaceDeltaReceipt {
	version: 1;
	kind: "workspace_delta";
	scope: {
		kind: "git_worktree";
		root: string;
		coverage: "tracked_and_untracked_nonignored";
	};
	outcome: WorkspaceDeltaOutcome;
	/** SHA-256 of the complete observed baseline state, when available. */
	beforeFingerprint?: string;
	/** SHA-256 of the complete observed final state, when available. */
	afterFingerprint?: string;
	observedAt: string;
	/** Stable machine-readable reason required for indeterminate observations. */
	reasonCode?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function fingerprint(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
		throw new TypeError(
			`WorkspaceDeltaReceipt.${field} must be a lowercase SHA-256 hex string.`,
		);
	}
	return value;
}

/** Strictly validates an untrusted workspace-delta receipt. */
export function normalizeWorkspaceDeltaReceipt(
	value: unknown,
): WorkspaceDeltaReceipt {
	const raw = record(value);
	const scope = record(raw?.scope);
	if (
		raw?.version !== 1 ||
		raw.kind !== "workspace_delta" ||
		scope?.kind !== "git_worktree" ||
		scope.coverage !== "tracked_and_untracked_nonignored" ||
		typeof scope.root !== "string" ||
		scope.root.trim().length === 0
	) {
		throw new TypeError(
			"WorkspaceDeltaReceipt has an invalid envelope or scope.",
		);
	}
	if (
		raw.outcome !== "changed" &&
		raw.outcome !== "unchanged" &&
		raw.outcome !== "indeterminate"
	) {
		throw new TypeError("WorkspaceDeltaReceipt has an invalid outcome.");
	}
	if (
		typeof raw.observedAt !== "string" ||
		!Number.isFinite(Date.parse(raw.observedAt))
	) {
		throw new TypeError(
			"WorkspaceDeltaReceipt.observedAt must be an ISO timestamp.",
		);
	}

	if (raw.outcome === "indeterminate") {
		if (typeof raw.reasonCode !== "string" || raw.reasonCode.length === 0) {
			throw new TypeError(
				"Indeterminate WorkspaceDeltaReceipt values require reasonCode.",
			);
		}
		return {
			version: 1,
			kind: "workspace_delta",
			scope: {
				kind: "git_worktree",
				root: scope.root,
				coverage: "tracked_and_untracked_nonignored",
			},
			outcome: "indeterminate",
			...(raw.beforeFingerprint === undefined
				? {}
				: {
						beforeFingerprint: fingerprint(
							raw.beforeFingerprint,
							"beforeFingerprint",
						),
					}),
			observedAt: raw.observedAt,
			reasonCode: raw.reasonCode,
		};
	}

	return {
		version: 1,
		kind: "workspace_delta",
		scope: {
			kind: "git_worktree",
			root: scope.root,
			coverage: "tracked_and_untracked_nonignored",
		},
		outcome: raw.outcome,
		beforeFingerprint: fingerprint(raw.beforeFingerprint, "beforeFingerprint"),
		afterFingerprint: fingerprint(raw.afterFingerprint, "afterFingerprint"),
		observedAt: raw.observedAt,
	};
}

/** Reads and validates the canonical receipt from ActionResult-style data. */
export function readWorkspaceDeltaReceipt(
	data: Record<string, unknown> | undefined,
): WorkspaceDeltaReceipt | undefined {
	const value = data?.[WORKSPACE_DELTA_RECEIPT_DATA_KEY];
	return value === undefined
		? undefined
		: normalizeWorkspaceDeltaReceipt(value);
}
