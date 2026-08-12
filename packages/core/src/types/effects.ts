/**
 * Canonical proof records for externally visible mutations. Action handlers
 * return these after persistence or provider acceptance; the message runtime
 * binds user-facing confirmation text to their stable IDs and never treats a
 * generic action success, preview, failure, or rollback as proof that a
 * requested change was applied. A replayed no-op proves an earlier committed
 * result still satisfies the request; a non-replayed no-op proves only an
 * explicitly classified effect-free operation.
 */

import { ElizaError } from "../errors";

/** A persisted resource or child artifact identified without embedding payload data. */
export interface EffectResourceRef {
	/** Namespaced resource type, for example `lifeops.routine`. */
	kind: string;
	/** Durable opaque identifier. Sensitive payload values never belong here. */
	id: string;
	/** Optional provider or store version used for optimistic concurrency. */
	version?: string;
}

/** Retry identity shared by every receipt outcome. */
export interface EffectIdempotency {
	/** Stable operation key, or null when the operation has no idempotency contract. */
	key: string | null;
	/** True only when this turn verified and reused an earlier committed result. */
	replayed: boolean;
}

interface EffectReceiptBase {
	/** Stable receipt identity used for current-turn claim binding and deduplication. */
	receiptId: string;
	/** Namespaced operation, for example `lifeops.routine.create`. */
	operation: string;
	/** Primary resource targeted or produced by the operation. */
	resource: EffectResourceRef;
	/** Child resources committed by the operation; explicitly empty when none exist. */
	artifacts: readonly EffectResourceRef[];
	/** Retry/replay identity for this operation. */
	idempotency: EffectIdempotency;
	/** ISO-8601 timestamp at which this outcome was observed. */
	observedAt: string;
}

/** A mutation proven durable locally or accepted by its authoritative provider. */
export interface AppliedEffectReceipt extends EffectReceiptBase {
	outcome: "applied";
	commit: {
		kind: "durable" | "provider_accepted";
		/** Durable transaction, row, or provider receipt identifier. */
		id: string;
		/** ISO-8601 timestamp at which the commit or acceptance completed. */
		committedAt: string;
	};
}

/** A proposed mutation which has not been persisted or sent. */
export interface PreviewEffectReceipt extends EffectReceiptBase {
	outcome: "preview";
}

/** An operation that intentionally made no change. */
export interface NoopEffectReceipt extends EffectReceiptBase {
	outcome: "noop";
	reason: string;
}

/** An attempted mutation that did not produce a verified commit. */
export interface FailedEffectReceipt extends EffectReceiptBase {
	outcome: "failed";
	failure: {
		code: string;
		retryable: boolean;
		/**
		 * `unknown` covers ambiguous provider outcomes and is deliberately not
		 * accepted as proof of application.
		 */
		acceptance: "rejected" | "unknown";
	};
}

/** A compensating operation that invalidates one or more earlier applied receipts. */
export interface RolledBackEffectReceipt extends EffectReceiptBase {
	outcome: "rolled_back";
	rollback: {
		/** Durable receipt for the compensating operation. */
		receiptId: string;
		/** Applied receipt IDs whose effects no longer remain committed. */
		revertedReceiptIds: readonly string[];
		/** ISO-8601 timestamp at which compensation completed. */
		rolledBackAt: string;
	};
}

/**
 * Mutation outcome emitted by an action. The discriminant keeps non-applied
 * outcomes structurally incapable of carrying an `applied` commit proof.
 */
export type EffectReceipt =
	| AppliedEffectReceipt
	| PreviewEffectReceipt
	| NoopEffectReceipt
	| FailedEffectReceipt
	| RolledBackEffectReceipt;

/**
 * A no-op that verified and reused an earlier committed result this turn.
 * Normalization rejects `replayed: true` with a null idempotency key, so a
 * replayed no-op always names the operation identity whose committed effect it
 * re-observed — which is why it can serve as desired-state proof below.
 */
export type ReplayedNoopEffectReceipt = NoopEffectReceipt & {
	idempotency: EffectIdempotency & { replayed: true };
};

/**
 * Receipts proving the desired state is durably committed: a fresh applied
 * commit, or a replayed no-op re-observing one (idempotent "already exists").
 * Previews, failures, rollbacks, and non-replayed no-ops never qualify.
 */
export type CommittedEffectReceipt =
	| AppliedEffectReceipt
	| ReplayedNoopEffectReceipt;

/**
 * Minimal result shape used by grounding helpers without importing ActionResult
 * back into this leaf module.
 */
export interface EffectBearingResult {
	success?: boolean;
	error?: unknown;
	verifiedUserFacing?: boolean;
	userFacingText?: string;
	/**
	 * Explicit assertion that the visible result describes no external mutation.
	 * Mutation-capable actions must instead bind their text to active receipts.
	 */
	userFacingEffect?: "none";
	effectReceipts?: readonly EffectReceipt[];
	userFacingEffectReceiptIds?: readonly string[];
}

const EFFECT_OUTCOMES = new Set<EffectReceipt["outcome"]>([
	"applied",
	"preview",
	"noop",
	"failed",
	"rolled_back",
]);

/** Capability tags which declare that an action may mutate external state. */
export const MUTATING_EFFECT_CAPABILITY_TAGS: ReadonlySet<string> = new Set([
	"capability:write",
	"capability:update",
	"capability:delete",
	"capability:schedule",
	"capability:send",
	"capability:delegate",
	"capability:execute",
]);

/**
 * Opt-in tag for handlers whose retry key and provider/store contract make a
 * repeated invocation equivalent to the first attempt. Mutating actions
 * without this tag are never retried automatically after an ambiguous throw.
 */
export const IDEMPOTENT_EFFECT_ACTION_TAG = "effect:idempotent";

/**
 * Opt-in tag for actions whose visible mutation outcome must be bound to a
 * validated receipt. Capability tags still disable unsafe automatic retries
 * across the whole action catalog; this separate tag lets receipt enforcement
 * roll out without suppressing callbacks from actions not yet migrated.
 */
export const EFFECT_RECEIPT_REQUIRED_ACTION_TAG = "effect:receipt-required";

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function invalid(message: string, context: Record<string, unknown>): never {
	throw new ElizaError(message, {
		code: "INVALID_EFFECT_RECEIPT",
		context,
		severity: "fatal",
	});
}

function nonEmptyString(
	value: unknown,
	field: string,
	context: Record<string, unknown>,
): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		return invalid(
			`Effect receipt field '${field}' must be a non-empty string.`,
			{
				...context,
				field,
			},
		);
	}
	return value.trim();
}

function isoTimestamp(
	value: unknown,
	field: string,
	context: Record<string, unknown>,
): string {
	const timestamp = nonEmptyString(value, field, context);
	const match =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/.exec(
			timestamp,
		);
	if (!match) {
		return invalid(
			`Effect receipt field '${field}' must be an ISO timestamp with a timezone.`,
			{
				...context,
				field,
			},
		);
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
	const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [
		31,
		leapYear ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	][month - 1];
	const parsed = Date.parse(timestamp);
	if (
		month < 1 ||
		month > 12 ||
		daysInMonth === undefined ||
		day < 1 ||
		day > daysInMonth ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		offsetHour > 23 ||
		offsetMinute > 59 ||
		!Number.isFinite(parsed)
	) {
		return invalid(
			`Effect receipt field '${field}' must be a valid ISO timestamp.`,
			{
				...context,
				field,
			},
		);
	}
	return new Date(parsed).toISOString();
}

function normalizeResourceRef(
	value: unknown,
	field: string,
	context: Record<string, unknown>,
): EffectResourceRef {
	const raw = record(value);
	if (!raw) {
		return invalid(
			`Effect receipt field '${field}' must be a resource reference.`,
			{
				...context,
				field,
			},
		);
	}
	const kind = nonEmptyString(raw.kind, `${field}.kind`, context);
	const id = nonEmptyString(raw.id, `${field}.id`, context);
	const version =
		raw.version === undefined
			? undefined
			: nonEmptyString(raw.version, `${field}.version`, context);
	return Object.freeze({
		kind,
		id,
		...(version ? { version } : {}),
	});
}

function normalizeStringArray(
	value: unknown,
	field: string,
	context: Record<string, unknown>,
): readonly string[] {
	if (!Array.isArray(value)) {
		return invalid(`Effect receipt field '${field}' must be an array.`, {
			...context,
			field,
		});
	}
	const values = value.map((entry, index) =>
		nonEmptyString(entry, `${field}[${index}]`, context),
	);
	if (new Set(values).size !== values.length) {
		return invalid(`Effect receipt field '${field}' contains duplicate IDs.`, {
			...context,
			field,
		});
	}
	return Object.freeze(values);
}

/** Canonicalize the receipt IDs bound to one exact user-facing message. */
export function normalizeUserFacingEffectReceiptIds(
	value: unknown,
): readonly string[] {
	return normalizeStringArray(value, "userFacingEffectReceiptIds", {});
}

/**
 * Validates, canonicalizes, and freezes one untrusted action receipt. Unknown
 * payload fields are intentionally discarded before the value reaches planner
 * prompts, trajectory records, streaming clients, or the turn ledger.
 */
export function normalizeEffectReceipt(value: unknown): EffectReceipt {
	const raw = record(value);
	if (!raw) {
		return invalid("Effect receipt must be an object.", {});
	}
	const receiptId = nonEmptyString(raw.receiptId, "receiptId", {});
	const context = { receiptId };
	const operation = nonEmptyString(raw.operation, "operation", context);
	const resource = normalizeResourceRef(raw.resource, "resource", context);
	if (!Array.isArray(raw.artifacts)) {
		return invalid(
			"Effect receipt field 'artifacts' must be an array.",
			context,
		);
	}
	const artifacts = Object.freeze(
		raw.artifacts.map((artifact, index) =>
			normalizeResourceRef(artifact, `artifacts[${index}]`, context),
		),
	);
	const idempotencyRaw = record(raw.idempotency);
	if (!idempotencyRaw) {
		return invalid(
			"Effect receipt field 'idempotency' must be an object.",
			context,
		);
	}
	const idempotencyKey =
		idempotencyRaw.key === null
			? null
			: nonEmptyString(idempotencyRaw.key, "idempotency.key", context);
	if (typeof idempotencyRaw.replayed !== "boolean") {
		return invalid(
			"Effect receipt field 'idempotency.replayed' must be a boolean.",
			context,
		);
	}
	if (idempotencyRaw.replayed && idempotencyKey === null) {
		return invalid(
			"Replayed effect receipts require an idempotency key.",
			context,
		);
	}
	const idempotency = Object.freeze({
		key: idempotencyKey,
		replayed: idempotencyRaw.replayed,
	});
	const observedAt = isoTimestamp(raw.observedAt, "observedAt", context);
	if (
		typeof raw.outcome !== "string" ||
		!EFFECT_OUTCOMES.has(raw.outcome as EffectReceipt["outcome"])
	) {
		return invalid("Effect receipt has an unsupported outcome.", {
			...context,
			outcome: raw.outcome,
		});
	}
	const outcome = raw.outcome as EffectReceipt["outcome"];
	const base = {
		receiptId,
		operation,
		resource,
		artifacts,
		idempotency,
		observedAt,
	};

	switch (outcome) {
		case "applied": {
			const commitRaw = record(raw.commit);
			if (!commitRaw) {
				return invalid(
					"Applied effect receipts require commit proof.",
					context,
				);
			}
			if (
				commitRaw.kind !== "durable" &&
				commitRaw.kind !== "provider_accepted"
			) {
				return invalid("Applied effect receipt has an invalid commit kind.", {
					...context,
					commitKind: commitRaw.kind,
				});
			}
			return Object.freeze({
				...base,
				outcome: "applied",
				commit: Object.freeze({
					kind: commitRaw.kind,
					id: nonEmptyString(commitRaw.id, "commit.id", context),
					committedAt: isoTimestamp(
						commitRaw.committedAt,
						"commit.committedAt",
						context,
					),
				}),
			});
		}
		case "preview":
			return Object.freeze({ ...base, outcome: "preview" });
		case "noop":
			return Object.freeze({
				...base,
				outcome: "noop",
				reason: nonEmptyString(raw.reason, "reason", context),
			});
		case "failed": {
			const failureRaw = record(raw.failure);
			if (!failureRaw) {
				return invalid(
					"Failed effect receipts require failure details.",
					context,
				);
			}
			if (typeof failureRaw.retryable !== "boolean") {
				return invalid(
					"Effect receipt field 'failure.retryable' must be a boolean.",
					context,
				);
			}
			if (
				failureRaw.acceptance !== "rejected" &&
				failureRaw.acceptance !== "unknown"
			) {
				return invalid(
					"Failed effect receipt has an invalid acceptance state.",
					context,
				);
			}
			return Object.freeze({
				...base,
				outcome: "failed",
				failure: Object.freeze({
					code: nonEmptyString(failureRaw.code, "failure.code", context),
					retryable: failureRaw.retryable,
					acceptance: failureRaw.acceptance,
				}),
			});
		}
		case "rolled_back": {
			const rollbackRaw = record(raw.rollback);
			if (!rollbackRaw) {
				return invalid(
					"Rolled-back effect receipts require rollback proof.",
					context,
				);
			}
			const revertedReceiptIds = normalizeStringArray(
				rollbackRaw.revertedReceiptIds,
				"rollback.revertedReceiptIds",
				context,
			);
			if (revertedReceiptIds.length === 0) {
				return invalid(
					"Rolled-back effect receipts must identify at least one reverted receipt.",
					context,
				);
			}
			return Object.freeze({
				...base,
				outcome: "rolled_back",
				rollback: Object.freeze({
					receiptId: nonEmptyString(
						rollbackRaw.receiptId,
						"rollback.receiptId",
						context,
					),
					revertedReceiptIds,
					rolledBackAt: isoTimestamp(
						rollbackRaw.rolledBackAt,
						"rollback.rolledBackAt",
						context,
					),
				}),
			});
		}
	}
}

/**
 * Canonicalizes a receipt list and rejects conflicting identities. Exact
 * duplicates are collapsed so provider retries cannot multiply one effect.
 */
export function normalizeEffectReceipts(
	value: unknown,
): readonly EffectReceipt[] {
	if (value === undefined) return Object.freeze([]);
	if (!Array.isArray(value)) {
		return invalid("ActionResult.effectReceipts must be an array.", {});
	}
	const byId = new Map<string, EffectReceipt>();
	for (const rawReceipt of value) {
		const receipt = normalizeEffectReceipt(rawReceipt);
		const existing = byId.get(receipt.receiptId);
		if (existing) {
			if (JSON.stringify(existing) !== JSON.stringify(receipt)) {
				return invalid(
					"Effect receipt ID was reused for a different outcome.",
					{
						receiptId: receipt.receiptId,
					},
				);
			}
			continue;
		}
		byId.set(receipt.receiptId, receipt);
	}
	return Object.freeze([...byId.values()]);
}

/** True when an action's capability tags declare a possible mutation. */
export function tagsMayProduceEffects(
	tags: readonly string[] | undefined,
): boolean {
	return (
		tags?.some((tag) =>
			MUTATING_EFFECT_CAPABILITY_TAGS.has(tag.trim().toLowerCase()),
		) === true
	);
}

/** Read-only actions may retry; effectful actions must explicitly opt in. */
export function tagsPermitAutomaticRetry(
	tags: readonly string[] | undefined,
): boolean {
	return (
		!tagsMayProduceEffects(tags) ||
		tags?.some(
			(tag) => tag.trim().toLowerCase() === IDEMPOTENT_EFFECT_ACTION_TAG,
		) === true
	);
}

/** True when an action has completed the receipt-contract migration. */
export function tagsRequireEffectReceipts(
	tags: readonly string[] | undefined,
): boolean {
	return (
		tags?.some(
			(tag) => tag.trim().toLowerCase() === EFFECT_RECEIPT_REQUIRED_ACTION_TAG,
		) === true
	);
}

/** Merge current-turn receipt lists while preserving validation and deduplication. */
export function mergeEffectReceipts(
	...lists: ReadonlyArray<readonly EffectReceipt[] | undefined>
): readonly EffectReceipt[] {
	return normalizeEffectReceipts(lists.flatMap((list) => list ?? []));
}

/** Applied receipts reverted later in the same turn are no longer valid proof. */
export function revertedEffectReceiptIds(
	receipts: readonly EffectReceipt[],
): ReadonlySet<string> {
	return new Set(
		receipts.flatMap((receipt) =>
			receipt.outcome === "rolled_back"
				? [...receipt.rollback.revertedReceiptIds]
				: [],
		),
	);
}

/**
 * Machine outcome after effect authority is applied. A nominally successful
 * result remains successful when it has no effect contract, explicitly proves
 * an effect-free result, or carries only active committed receipts. Failed,
 * preview, and rollback outcomes are incomplete; a later rollback also revokes
 * the earlier applied/replayed result it names. Unrelated receipts from other
 * operations do not change this result's status.
 */
export function effectiveMachineSuccess(
	result: EffectBearingResult | undefined,
	allTurnReceipts: readonly EffectReceipt[] = result?.effectReceipts ?? [],
): boolean {
	if (result?.success !== true || result.error != null) return false;
	if (result.effectReceipts === undefined) return true;
	const resultReceipts = normalizeEffectReceipts(result.effectReceipts);
	if (resultReceipts.length === 0) return result.userFacingEffect === "none";
	const receipts = mergeEffectReceipts(resultReceipts, allTurnReceipts);
	const reverted = revertedEffectReceiptIds(receipts);
	return resultReceipts.every(
		(receipt) =>
			!reverted.has(receipt.receiptId) &&
			(result.userFacingEffect === "none"
				? receipt.outcome === "noop" && !receipt.idempotency.replayed
				: isCommittedEffectReceipt(receipt)),
	);
}

/** Resolve every current-turn receipt bound to exact action-owned text. */
export function resolveUserFacingEffectReceipts(
	result: EffectBearingResult,
	allTurnReceipts: readonly EffectReceipt[] = result.effectReceipts ?? [],
): readonly EffectReceipt[] | null {
	if (
		result.verifiedUserFacing !== true ||
		typeof result.userFacingText !== "string" ||
		result.userFacingText.trim().length === 0 ||
		!Array.isArray(result.userFacingEffectReceiptIds) ||
		result.userFacingEffectReceiptIds.length === 0
	) {
		return null;
	}
	const normalizedReceipts = normalizeEffectReceipts(allTurnReceipts);
	const normalizedIds = normalizeStringArray(
		result.userFacingEffectReceiptIds,
		"userFacingEffectReceiptIds",
		{},
	);
	const byId = new Map(
		normalizedReceipts.map((receipt) => [receipt.receiptId, receipt]),
	);
	const resolved: EffectReceipt[] = [];
	for (const id of normalizedIds) {
		const receipt = byId.get(id);
		if (!receipt) return null;
		resolved.push(receipt);
	}
	return Object.freeze(resolved);
}

// A replayed no-op is proof the desired state is durably committed: the
// handler verified this turn that an earlier committed result already covers
// the request. Non-replayed no-ops stay rejected — "nothing changed" without a
// verified prior commit proves nothing.
function isCommittedEffectReceipt(
	receipt: EffectReceipt,
): receipt is CommittedEffectReceipt {
	return (
		receipt.outcome === "applied" ||
		(receipt.outcome === "noop" && receipt.idempotency.replayed)
	);
}

/**
 * Resolve the receipts bound to exact action-owned user-facing text. Every ID
 * must exist, prove committed desired state (applied, or a replayed no-op
 * re-observing an earlier commit), and remain active after any same-turn
 * rollback.
 */
export function resolveAppliedUserFacingEffectReceipts(
	result: EffectBearingResult,
	allTurnReceipts: readonly EffectReceipt[] = result.effectReceipts ?? [],
): readonly CommittedEffectReceipt[] | null {
	const resolved = resolveUserFacingEffectReceipts(result, allTurnReceipts);
	if (!resolved) return null;
	const normalizedReceipts = normalizeEffectReceipts(allTurnReceipts);
	const reverted = revertedEffectReceiptIds(normalizedReceipts);
	if (
		resolved.some(
			(receipt) =>
				!isCommittedEffectReceipt(receipt) || reverted.has(receipt.receiptId),
		)
	) {
		return null;
	}
	return Object.freeze(resolved as CommittedEffectReceipt[]);
}

/** True only when exact verified text is bound to active committed receipts. */
export function hasAppliedUserFacingEffectProof(
	result: EffectBearingResult,
	allTurnReceipts?: readonly EffectReceipt[],
): boolean {
	return (
		resolveAppliedUserFacingEffectReceipts(result, allTurnReceipts) !== null
	);
}
