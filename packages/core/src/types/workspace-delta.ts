/**
 * Typed, content-free observations of net workspace changes made by a tool.
 * Receipts live under the canonical ActionResult.data key so existing action,
 * streaming, trajectory, and planner transports preserve them unchanged.
 */

/** Canonical ActionResult.data key for a workspace delta observation. */
export const WORKSPACE_DELTA_RECEIPT_DATA_KEY =
	"workspaceDeltaReceipt" as const;

export type WorkspaceDeltaOutcome = "changed" | "unchanged" | "indeterminate";

export const WORKSPACE_DELTA_INDETERMINATE_REASON_CODES = [
	"WORKTREE_PROBE_FAILED",
	"BASELINE_SNAPSHOT_FAILED",
	"POST_SNAPSHOT_FAILED",
	"OBSERVATION_TIME_BUDGET_EXCEEDED",
	"OBSERVATION_BYTE_BUDGET_EXCEEDED",
	"OBSERVATION_OUTPUT_BUDGET_EXCEEDED",
	"REMOTE_EXECUTION_UNOBSERVED",
	"BACKGROUND_RECEIPT_PENDING",
] as const;

export type WorkspaceDeltaIndeterminateReasonCode =
	(typeof WORKSPACE_DELTA_INDETERMINATE_REASON_CODES)[number];

export interface WorkspaceDeltaReceipt {
	version: 1;
	kind: "workspace_delta";
	scope: {
		kind: "git_worktree";
		/** Display-only root; machine matching uses the opaque identities. */
		root: string;
		rootId: string;
		executionDomainId: string;
		coverage: "tracked_and_untracked_nonignored";
	};
	operation?: {
		kind: "background_shell";
		handle: string;
		status: "running" | "terminating" | "exited" | "killed" | "error";
	};
	outcome: WorkspaceDeltaOutcome;
	/** SHA-256 of the complete observed baseline state, when available. */
	beforeFingerprint?: string;
	/** SHA-256 of the complete observed final state, when available. */
	afterFingerprint?: string;
	observedAt: string;
	/** Stable machine-readable reason required for indeterminate observations. */
	reasonCode?: WorkspaceDeltaIndeterminateReasonCode;
}

type WorkspaceDeltaOperation = NonNullable<WorkspaceDeltaReceipt["operation"]>;

const RECEIPT_KEYS: ReadonlySet<string> = new Set([
	"version",
	"kind",
	"scope",
	"outcome",
	"observedAt",
	"operation",
	"beforeFingerprint",
	"afterFingerprint",
	"reasonCode",
]);
const SCOPE_KEYS: ReadonlySet<string> = new Set([
	"kind",
	"root",
	"rootId",
	"executionDomainId",
	"coverage",
]);
const OPERATION_KEYS: ReadonlySet<string> = new Set([
	"kind",
	"handle",
	"status",
]);
const OPERATION_STATUSES: ReadonlySet<unknown> = new Set<
	WorkspaceDeltaOperation["status"]
>(["running", "terminating", "exited", "killed", "error"]);

function assertExactKeys(
	value: Record<string, unknown>,
	allowedKeys: ReadonlySet<string>,
	label: string,
): void {
	const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
	if (unexpected.length > 0) {
		throw new TypeError(
			`${label} has unexpected fields: ${unexpected.join(", ")}.`,
		);
	}
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
	if (raw) {
		assertExactKeys(raw, RECEIPT_KEYS, "WorkspaceDeltaReceipt");
	}
	if (scope) {
		assertExactKeys(scope, SCOPE_KEYS, "WorkspaceDeltaReceipt.scope");
	}
	if (
		raw?.version !== 1 ||
		raw.kind !== "workspace_delta" ||
		scope?.kind !== "git_worktree" ||
		scope.coverage !== "tracked_and_untracked_nonignored" ||
		typeof scope.root !== "string" ||
		scope.root.length === 0 ||
		scope.root.trim() !== scope.root ||
		/[\0\r\n]/.test(scope.root)
	) {
		throw new TypeError(
			"WorkspaceDeltaReceipt has an invalid envelope or scope.",
		);
	}
	const rootId = fingerprint(scope.rootId, "scope.rootId");
	const normalizedScope: WorkspaceDeltaReceipt["scope"] = {
		kind: "git_worktree",
		root: scope.root,
		rootId,
		executionDomainId: fingerprint(
			scope.executionDomainId,
			"scope.executionDomainId",
		),
		coverage: "tracked_and_untracked_nonignored",
	};
	const operation = record(raw.operation);
	if (operation) {
		assertExactKeys(
			operation,
			OPERATION_KEYS,
			"WorkspaceDeltaReceipt.operation",
		);
		if (
			operation.kind !== "background_shell" ||
			typeof operation.handle !== "string" ||
			operation.handle.length === 0 ||
			operation.handle.length > 200 ||
			operation.handle.trim() !== operation.handle ||
			/[\0\r\n]/.test(operation.handle) ||
			!OPERATION_STATUSES.has(operation.status)
		) {
			throw new TypeError("WorkspaceDeltaReceipt has an invalid operation.");
		}
	} else if (raw.operation !== undefined) {
		throw new TypeError("WorkspaceDeltaReceipt has an invalid operation.");
	}
	const operationField: { operation?: WorkspaceDeltaOperation } = operation
		? {
				operation: {
					kind: "background_shell",
					handle: operation.handle as string,
					status: operation.status as WorkspaceDeltaOperation["status"],
				},
			}
		: {};
	if (
		raw.outcome !== "changed" &&
		raw.outcome !== "unchanged" &&
		raw.outcome !== "indeterminate"
	) {
		throw new TypeError("WorkspaceDeltaReceipt has an invalid outcome.");
	}
	if (
		typeof raw.observedAt !== "string" ||
		!Number.isFinite(Date.parse(raw.observedAt)) ||
		new Date(raw.observedAt).toISOString() !== raw.observedAt
	) {
		throw new TypeError(
			"WorkspaceDeltaReceipt.observedAt must be an ISO timestamp.",
		);
	}

	if (raw.outcome === "indeterminate") {
		if (
			typeof raw.reasonCode !== "string" ||
			!WORKSPACE_DELTA_INDETERMINATE_REASON_CODES.includes(
				raw.reasonCode as WorkspaceDeltaIndeterminateReasonCode,
			)
		) {
			throw new TypeError(
				"Indeterminate WorkspaceDeltaReceipt values require a canonical reasonCode.",
			);
		}
		if (raw.afterFingerprint !== undefined) {
			throw new TypeError(
				"Indeterminate WorkspaceDeltaReceipt values cannot include afterFingerprint.",
			);
		}
		if (
			raw.reasonCode === "BACKGROUND_RECEIPT_PENDING" &&
			operation === undefined
		) {
			throw new TypeError(
				"A pending background WorkspaceDeltaReceipt requires its operation handle.",
			);
		}
		if (
			operation &&
			(raw.reasonCode === "BACKGROUND_RECEIPT_PENDING"
				? operation.status !== "running" && operation.status !== "terminating"
				: operation.status !== "exited" &&
					operation.status !== "killed" &&
					operation.status !== "error")
		) {
			throw new TypeError(
				"WorkspaceDeltaReceipt operation status contradicts its observation state.",
			);
		}
		return {
			version: 1,
			kind: "workspace_delta",
			scope: normalizedScope,
			...operationField,
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
			reasonCode: raw.reasonCode as WorkspaceDeltaIndeterminateReasonCode,
		};
	}
	if (raw.reasonCode !== undefined) {
		throw new TypeError(
			"Observed WorkspaceDeltaReceipt values cannot include reasonCode.",
		);
	}
	if (
		operation &&
		operation.status !== "exited" &&
		operation.status !== "killed" &&
		operation.status !== "error"
	) {
		throw new TypeError(
			"Observed WorkspaceDeltaReceipt operations require a terminal status.",
		);
	}
	const beforeFingerprint = fingerprint(
		raw.beforeFingerprint,
		"beforeFingerprint",
	);
	const afterFingerprint = fingerprint(
		raw.afterFingerprint,
		"afterFingerprint",
	);
	if (
		(raw.outcome === "changed" && beforeFingerprint === afterFingerprint) ||
		(raw.outcome === "unchanged" && beforeFingerprint !== afterFingerprint)
	) {
		throw new TypeError(
			`WorkspaceDeltaReceipt fingerprints contradict outcome ${raw.outcome}.`,
		);
	}

	return {
		version: 1,
		kind: "workspace_delta",
		scope: normalizedScope,
		...operationField,
		outcome: raw.outcome,
		beforeFingerprint,
		afterFingerprint,
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
