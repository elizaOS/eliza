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
	/** Required when `status` is `indeterminate`, forbidden otherwise. */
	reason?: WorkspaceDeltaIndeterminateReason;
	/**
	 * Digest of the pre-execution fingerprint. Required by `changed` and
	 * `unchanged`; on `indeterminate` it is present only when the baseline
	 * capture succeeded and the post-execution capture is what failed.
	 */
	beforeFingerprint?: string;
	/**
	 * Digest of the post-execution fingerprint. Required by `changed` and
	 * `unchanged` — equal to `beforeFingerprint` for `unchanged` and different
	 * for `changed` — and never present on `indeterminate`, which by definition
	 * never completed both captures.
	 */
	afterFingerprint?: string;
}

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Whether an `indeterminate` receipt may carry a `beforeFingerprint`, keyed by
 * the capture failure its reason names. A baseline that never completed cannot
 * have produced a digest, so those reasons forbid one; a post-execution
 * failure always has the baseline in hand, so it requires one. Only
 * `git_unavailable` is legitimately either, because git can disappear before
 * the baseline capture or between the two captures.
 */
const INDETERMINATE_BEFORE_FINGERPRINT: Readonly<
	Record<
		WorkspaceDeltaIndeterminateReason,
		"required" | "forbidden" | "optional"
	>
> = {
	not_a_git_worktree: "forbidden",
	baseline_capture_failed: "forbidden",
	execution_route_unknown: "forbidden",
	post_capture_failed: "required",
	git_unavailable: "optional",
};

function isFingerprint(value: unknown): value is string {
	return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

/**
 * Validates an untrusted value as a {@link WorkspaceDeltaReceipt}, failing
 * closed unless the receipt's own fields prove the status it declares.
 *
 * A well-formed shape is deliberately not enough. This value is the evidence
 * the planner's coding completion gate acts on, and it arrives inside an
 * `ActionResult` the runtime does not control, so a receipt that merely
 * *claims* `unchanged` — with no digests at all, or with two digests that
 * disagree — would clear a pending mutation without ever establishing a
 * before/after relationship. Such receipts are rejected here rather than
 * downgraded, because a caller that cannot tell a proven verdict from an
 * asserted one has no safe way to use the difference.
 *
 * The accepted shapes are exactly the ones the coding-tools producer emits:
 * `changed`/`unchanged` carry both digests and no reason, with a digest
 * relationship matching the verdict; `indeterminate` carries a typed reason
 * and only the digests its particular capture failure could have produced.
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

	let beforeFingerprint: string | undefined;
	if (candidate.beforeFingerprint !== undefined) {
		if (!isFingerprint(candidate.beforeFingerprint)) return null;
		beforeFingerprint = candidate.beforeFingerprint;
	}
	let afterFingerprint: string | undefined;
	if (candidate.afterFingerprint !== undefined) {
		if (!isFingerprint(candidate.afterFingerprint)) return null;
		afterFingerprint = candidate.afterFingerprint;
	}

	if (status === "indeterminate") {
		const reason = candidate.reason;
		if (
			typeof reason !== "string" ||
			!WORKSPACE_DELTA_INDETERMINATE_REASONS.includes(
				reason as WorkspaceDeltaIndeterminateReason,
			)
		) {
			return null;
		}
		// No indeterminate path ever completes the post-execution capture, so an
		// `afterFingerprint` contradicts the status it is attached to.
		if (afterFingerprint !== undefined) return null;
		const rule =
			INDETERMINATE_BEFORE_FINGERPRINT[
				reason as WorkspaceDeltaIndeterminateReason
			];
		if (rule === "required" && beforeFingerprint === undefined) return null;
		if (rule === "forbidden" && beforeFingerprint !== undefined) return null;
		const receipt: WorkspaceDeltaReceipt = {
			version: WORKSPACE_DELTA_RECEIPT_VERSION,
			status: "indeterminate",
			reason: reason as WorkspaceDeltaIndeterminateReason,
		};
		if (beforeFingerprint !== undefined) {
			receipt.beforeFingerprint = beforeFingerprint;
		}
		return receipt;
	}

	// `changed` and `unchanged` are claims about a completed before/after pair:
	// both digests must be present, a reason would contradict the status, and
	// the digest relationship must be the one the verdict asserts.
	if (candidate.reason !== undefined) return null;
	if (beforeFingerprint === undefined || afterFingerprint === undefined) {
		return null;
	}
	if ((beforeFingerprint === afterFingerprint) !== (status === "unchanged")) {
		return null;
	}
	return {
		version: WORKSPACE_DELTA_RECEIPT_VERSION,
		status: status as WorkspaceDeltaStatus,
		beforeFingerprint,
		afterFingerprint,
	};
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
