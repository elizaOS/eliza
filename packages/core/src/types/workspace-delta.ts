/**
 * Content-free attestation of whether the local Git workspace changed across a
 * single foreground SHELL execution. The coding-tools plugin fingerprints the
 * workspace immediately before and after the command and attaches the receipt
 * under the canonical `ActionResult.data` key below; the planner's coding
 * completion gate reads it to decide whether a file mutation is pending or a
 * verification command left the workspace untouched. The receipt deliberately
 * carries no file names, contents, or diffs — only the tri-state verdict,
 * opaque fingerprint digests, and a typed reason when the relationship could
 * not be established. Remote capability-router execution never produces a
 * local receipt, and background shell sessions are out of scope.
 */

/** Canonical `ActionResult.data` key carrying a {@link WorkspaceDeltaReceipt}. */
export const WORKSPACE_DELTA_RECEIPT_KEY = "workspace_delta" as const;

/** Receipt schema version accepted by {@link parseWorkspaceDeltaReceipt}. */
export const WORKSPACE_DELTA_RECEIPT_VERSION = 1 as const;

export type WorkspaceDeltaStatus = "changed" | "unchanged" | "indeterminate";

/** Why a receipt is `indeterminate` — the only status that carries a reason. */
export type WorkspaceDeltaIndeterminateReason =
	| "not_a_git_worktree"
	| "git_unavailable"
	| "baseline_capture_failed"
	| "post_capture_failed"
	| "execution_route_unknown";

const WORKSPACE_DELTA_STATUSES: readonly WorkspaceDeltaStatus[] = [
	"changed",
	"unchanged",
	"indeterminate",
];

const WORKSPACE_DELTA_INDETERMINATE_REASONS: readonly WorkspaceDeltaIndeterminateReason[] =
	[
		"not_a_git_worktree",
		"git_unavailable",
		"baseline_capture_failed",
		"post_capture_failed",
		"execution_route_unknown",
	];

/**
 * Typed, content-free before/after relationship of the local Git workspace for
 * one foreground SHELL execution. Fingerprints are opaque SHA-256 hex digests
 * of the canonical workspace state (HEAD, status, index identity, and the
 * contents of dirty tracked plus non-ignored untracked files); they expose no
 * workspace details and exist only so `changed`/`unchanged` verdicts remain
 * auditable against each other.
 */
export interface WorkspaceDeltaReceipt {
	version: typeof WORKSPACE_DELTA_RECEIPT_VERSION;
	status: WorkspaceDeltaStatus;
	/** Present only when `status` is `indeterminate`. */
	reason?: WorkspaceDeltaIndeterminateReason;
	/** Digest of the pre-execution fingerprint; absent when capture failed. */
	beforeFingerprint?: string;
	/** Digest of the post-execution fingerprint; absent when capture failed. */
	afterFingerprint?: string;
}

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Validates an untrusted value as a {@link WorkspaceDeltaReceipt}. Returns
 * `null` for anything malformed instead of guessing — a malformed receipt must
 * never pass as evidence that the workspace stayed unchanged.
 */
export function parseWorkspaceDeltaReceipt(
	value: unknown,
): WorkspaceDeltaReceipt | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as Record<string, unknown>;
	if (candidate.version !== WORKSPACE_DELTA_RECEIPT_VERSION) return null;
	const status = candidate.status;
	if (
		typeof status !== "string" ||
		!WORKSPACE_DELTA_STATUSES.includes(status as WorkspaceDeltaStatus)
	) {
		return null;
	}
	const reason = candidate.reason;
	if (reason !== undefined) {
		if (
			typeof reason !== "string" ||
			!WORKSPACE_DELTA_INDETERMINATE_REASONS.includes(
				reason as WorkspaceDeltaIndeterminateReason,
			) ||
			status !== "indeterminate"
		) {
			return null;
		}
	}
	for (const key of ["beforeFingerprint", "afterFingerprint"] as const) {
		const digest = candidate[key];
		if (digest === undefined) continue;
		if (typeof digest !== "string" || !FINGERPRINT_PATTERN.test(digest)) {
			return null;
		}
	}
	const receipt: WorkspaceDeltaReceipt = {
		version: WORKSPACE_DELTA_RECEIPT_VERSION,
		status: status as WorkspaceDeltaStatus,
	};
	if (reason !== undefined) {
		receipt.reason = reason as WorkspaceDeltaIndeterminateReason;
	}
	if (typeof candidate.beforeFingerprint === "string") {
		receipt.beforeFingerprint = candidate.beforeFingerprint;
	}
	if (typeof candidate.afterFingerprint === "string") {
		receipt.afterFingerprint = candidate.afterFingerprint;
	}
	return receipt;
}

/**
 * Reads and validates the receipt stored under
 * {@link WORKSPACE_DELTA_RECEIPT_KEY} in an `ActionResult.data` record.
 */
export function readWorkspaceDeltaReceipt(
	data: unknown,
): WorkspaceDeltaReceipt | null {
	if (typeof data !== "object" || data === null) return null;
	return parseWorkspaceDeltaReceipt(
		(data as Record<string, unknown>)[WORKSPACE_DELTA_RECEIPT_KEY],
	);
}
