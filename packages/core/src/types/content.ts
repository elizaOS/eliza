/**
 * Defines the source-neutral progressive-read envelope shared by native file,
 * document, attachment, email, memory, and tool-result adapters. References are
 * model-safe opaque tokens, never native paths, account identifiers, or ambient
 * authorization; every continuation is resolved again by its owning service.
 */

export const CONTENT_REFERENCE_KINDS = [
	"file",
	"document",
	"attachment",
	"email",
	"memory",
	"tool-result",
] as const;

export type ContentReferenceKind = (typeof CONTENT_REFERENCE_KINDS)[number];

export const READ_RANGE_UNITS = ["line", "fragment", "byte"] as const;

export type ReadRangeUnit = (typeof READ_RANGE_UNITS)[number];

export const READ_COMPLETENESS_VALUES = [
	"complete",
	"partial-recoverable",
	"partial-source-loss",
	"unavailable",
] as const;

export type ReadCompleteness = (typeof READ_COMPLETENESS_VALUES)[number];

export interface ContentReference {
	kind: ContentReferenceKind;
	ref: string;
	revision?: string;
}

export interface ReadRange {
	unit: ReadRangeUnit;
	/** Inclusive, zero-based source offset. */
	start: number;
	/** Exclusive source offset. */
	end: number;
	total?: number;
}

export interface ReadSlice {
	range: ReadRange;
	hasPrevious: boolean;
	hasMore: boolean;
	nextOffset?: number;
	revision?: string;
	completeness: ReadCompleteness;
	sliceSha256: string;
	sourceSha256?: string;
	reason?: string;
}

export interface ReadView {
	reference: ContentReference;
	slice: ReadSlice;
}

export interface BuildReadSliceInput {
	range: ReadRange;
	completeness: ReadCompleteness;
	sliceSha256: string;
	revision?: string;
	sourceSha256?: string;
	reason?: string;
}

const CONTENT_REFERENCE_KIND_SET = new Set<string>(CONTENT_REFERENCE_KINDS);
const READ_RANGE_UNIT_SET = new Set<string>(READ_RANGE_UNITS);
const READ_COMPLETENESS_SET = new Set<string>(READ_COMPLETENESS_VALUES);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const OPAQUE_REFERENCE_PATTERN = /^[A-Za-z0-9._:~-]{1,256}$/u;
const CONTENT_REFERENCE_KEYS = new Set(["kind", "ref", "revision"]);
const READ_RANGE_KEYS = new Set(["unit", "start", "end", "total"]);
const READ_SLICE_KEYS = new Set([
	"range",
	"hasPrevious",
	"hasMore",
	"nextOffset",
	"revision",
	"completeness",
	"sliceSha256",
	"sourceSha256",
	"reason",
]);
const READ_VIEW_KEYS = new Set(["reference", "slice"]);

function fail(message: string): never {
	throw new TypeError(`Invalid progressive content contract: ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return fail(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function rejectUnknownKeys(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	label: string,
): void {
	const unknown = Object.keys(value).filter((key) => !allowed.has(key));
	if (unknown.length > 0) {
		fail(`${label} contains unsupported field(s): ${unknown.join(", ")}`);
	}
}

function safeOffset(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		return fail(`${label} must be a nonnegative safe integer`);
	}
	return value;
}

function optionalNonEmptyString(
	value: unknown,
	label: string,
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) {
		return fail(`${label} must be a nonempty string when present`);
	}
	return value;
}

function sha256(value: unknown, label: string): string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		return fail(`${label} must be a lowercase SHA-256 hex digest`);
	}
	return value;
}

export function validateContentReference(value: unknown): ContentReference {
	const input = record(value, "reference");
	rejectUnknownKeys(input, CONTENT_REFERENCE_KEYS, "reference");
	if (
		typeof input.kind !== "string" ||
		!CONTENT_REFERENCE_KIND_SET.has(input.kind)
	) {
		return fail("reference.kind is unsupported");
	}
	if (
		typeof input.ref !== "string" ||
		!OPAQUE_REFERENCE_PATTERN.test(input.ref)
	) {
		return fail(
			"reference.ref must be an opaque token without paths, addresses, or whitespace",
		);
	}
	return {
		kind: input.kind as ContentReferenceKind,
		ref: input.ref,
		...(optionalNonEmptyString(input.revision, "reference.revision")
			? { revision: input.revision as string }
			: {}),
	};
}

export function validateReadSlice(value: unknown): ReadSlice {
	const input = record(value, "slice");
	rejectUnknownKeys(input, READ_SLICE_KEYS, "slice");
	const rawRange = record(input.range, "slice.range");
	rejectUnknownKeys(rawRange, READ_RANGE_KEYS, "slice.range");
	if (
		typeof rawRange.unit !== "string" ||
		!READ_RANGE_UNIT_SET.has(rawRange.unit)
	) {
		return fail("slice.range.unit is unsupported");
	}
	const start = safeOffset(rawRange.start, "slice.range.start");
	const end = safeOffset(rawRange.end, "slice.range.end");
	const total =
		rawRange.total === undefined
			? undefined
			: safeOffset(rawRange.total, "slice.range.total");
	if (start > end) fail("slice.range.start must not exceed end");
	if (total !== undefined && end > total) {
		fail("slice.range.end must not exceed total");
	}
	if (input.hasPrevious !== start > 0) {
		fail("slice.hasPrevious must equal range.start > 0");
	}
	if (typeof input.hasMore !== "boolean") {
		fail("slice.hasMore must be boolean");
	}
	if (
		typeof input.completeness !== "string" ||
		!READ_COMPLETENESS_SET.has(input.completeness)
	) {
		return fail("slice.completeness is unsupported");
	}
	const completeness = input.completeness as ReadCompleteness;
	const nextOffset =
		input.nextOffset === undefined
			? undefined
			: safeOffset(input.nextOffset, "slice.nextOffset");
	const recoverable = completeness === "partial-recoverable";
	if (input.hasMore !== recoverable) {
		fail("slice.hasMore is true only for partial-recoverable slices");
	}
	if (recoverable && (nextOffset !== end || end <= start)) {
		fail("recoverable slice.nextOffset must equal an advancing range.end");
	}
	if (!recoverable && nextOffset !== undefined) {
		fail("slice.nextOffset is allowed only for partial-recoverable slices");
	}
	if (completeness === "complete" && total !== undefined && end !== total) {
		fail("complete slice.range.end must equal total");
	}
	const revision = optionalNonEmptyString(input.revision, "slice.revision");
	const sourceSha256 =
		input.sourceSha256 === undefined
			? undefined
			: sha256(input.sourceSha256, "slice.sourceSha256");
	if (recoverable && revision === undefined && sourceSha256 === undefined) {
		fail("recoverable slices require revision or sourceSha256 identity");
	}
	const reason = optionalNonEmptyString(input.reason, "slice.reason");
	return {
		range: {
			unit: rawRange.unit as ReadRangeUnit,
			start,
			end,
			...(total === undefined ? {} : { total }),
		},
		hasPrevious: start > 0,
		hasMore: recoverable,
		...(recoverable ? { nextOffset: end } : {}),
		...(revision ? { revision } : {}),
		completeness,
		sliceSha256: sha256(input.sliceSha256, "slice.sliceSha256"),
		...(sourceSha256 ? { sourceSha256 } : {}),
		...(reason ? { reason } : {}),
	};
}

export function validateReadView(value: unknown): ReadView {
	const input = record(value, "readView");
	rejectUnknownKeys(input, READ_VIEW_KEYS, "readView");
	const reference = validateContentReference(input.reference);
	const slice = validateReadSlice(input.slice);
	if (
		reference.revision !== undefined &&
		slice.revision !== undefined &&
		reference.revision !== slice.revision
	) {
		fail("reference and slice revisions must match");
	}
	return { reference, slice };
}

export function isReadView(value: unknown): value is ReadView {
	try {
		validateReadView(value);
		return true;
	} catch {
		// error-policy:J3 untrusted model/plugin metadata uses false as the explicit
		// invalid result; callers that need diagnostics use validateReadView.
		return false;
	}
}

export function buildContentReference(
	input: ContentReference,
): ContentReference {
	return validateContentReference(input);
}

export function buildReadSlice(input: BuildReadSliceInput): ReadSlice {
	return validateReadSlice({
		...input,
		hasPrevious: input.range.start > 0,
		hasMore: input.completeness === "partial-recoverable",
		...(input.completeness === "partial-recoverable"
			? { nextOffset: input.range.end }
			: {}),
	});
}

export function buildReadView(input: ReadView): ReadView {
	return validateReadView(input);
}
