/** Wire-only rendering of historical outcome records. Original context events
 * remain authoritative for source selection, authorization and restoration. */

import { type EffectReceipt, normalizeEffectReceipt } from "../types/effects";
import { isObjectRecord } from "../utils/type-guards";
import { collectCompletionContextSources } from "./completion-context";
import { hashStableJson } from "./context-hash";
import type {
	ContextObject,
	ContextObjectPromptSegment,
} from "./context-object";

/** The segment id prefix of a later authoritative proposal state record. Its
 * suffix is the proposal (device approval) id the record supersedes. */
export const HISTORICAL_PROPOSAL_TERMINAL_ID_PREFIX =
	"historical-proposal-terminal:";

type Field = "navigation" | "outcomes" | "observations";

const RECORD_FIELDS: Readonly<Record<string, Field>> = {
	"runtime:historical_navigation": "navigation",
	"runtime:historical_effects": "outcomes",
	"runtime:historical_observations": "observations",
};

const NAVIGATION_RECEIPT_FIELDS: ReadonlySet<string> = new Set([
	"effect",
	"stepId",
	"viewId",
	"status",
	"reason",
	"handoffId",
	"label",
	"subview",
	"path",
	"resolvedAlias",
]);
/** Step and handoff identities bind delivery inside the turn that ran it; the
 * effect name is the record's label. No later step reads them back. */
const NAVIGATION_DROPPED_FIELDS: ReadonlySet<string> = new Set([
	"effect",
	"stepId",
	"handoffId",
]);

type Outcome = Record<string, unknown>;
type Entry = {
	field: Field;
	columns: string[];
	scope?: string;
	request: string;
	outcomes: Outcome[];
	/** Parsed receipts in outcome order: effect receipts or navigation objects. */
	receipts: (EffectReceipt | Record<string, unknown>)[];
};

/** Only exact canonical records the runtime writes are eligible; anything else
 * stays as it is. Effect receipts must already be in normalized form. */
function recordEntry(segment: ContextObjectPromptSegment): Entry | undefined {
	const field = segment.label ? RECORD_FIELDS[segment.label] : undefined;
	if (!field || segment.stable) return undefined;
	let record: unknown;
	try {
		record = JSON.parse(segment.content);
	} catch {
		// error-policy:J3 Keep malformed historical text unchanged on the wire.
		return undefined;
	}
	if (JSON.stringify(record) !== segment.content) return undefined;
	if (
		!isObjectRecord(record) ||
		typeof record.requestSourceEventId !== "string"
	)
		return undefined;
	const allowed =
		field === "navigation"
			? ["requestSourceEventId", field]
			: ["requestSourceEventId", "scope", field];
	if (JSON.stringify(Object.keys(record)) !== JSON.stringify(allowed))
		return undefined;
	if (field !== "navigation" && typeof record.scope !== "string")
		return undefined;
	const outcomes = record[field];
	if (!Array.isArray(outcomes) || outcomes.length === 0) return undefined;
	const columns = Object.keys(outcomes[0] ?? {});
	const allowedColumns =
		field === "navigation"
			? ["success", "receipt"]
			: ["actionName", "success", "receipt"];
	if (
		!columns.includes("success") ||
		!columns.includes("receipt") ||
		columns.some((key) => !allowedColumns.includes(key))
	)
		return undefined;
	const receipts: Entry["receipts"] = [];
	for (const outcome of outcomes) {
		if (
			!isObjectRecord(outcome) ||
			JSON.stringify(Object.keys(outcome)) !== JSON.stringify(columns) ||
			typeof outcome.success !== "boolean" ||
			("actionName" in outcome && typeof outcome.actionName !== "string")
		)
			return undefined;
		const receipt =
			field === "navigation"
				? navigationReceipt(outcome.receipt)
				: effectReceipt(outcome.receipt);
		if (!receipt) return undefined;
		receipts.push(receipt);
	}
	return {
		field,
		columns,
		...(field === "navigation" ? {} : { scope: record.scope as string }),
		request: record.requestSourceEventId,
		outcomes: outcomes as Outcome[],
		receipts,
	};
}

function effectReceipt(value: unknown): EffectReceipt | undefined {
	if (!isObjectRecord(value)) return undefined;
	try {
		const receipt = normalizeEffectReceipt(value);
		return hashStableJson(receipt) === hashStableJson(value)
			? receipt
			: undefined;
	} catch {
		// error-policy:J3 A receipt the runtime did not normalize stays unchanged.
		return undefined;
	}
}

function navigationReceipt(value: unknown) {
	if (typeof value !== "string") return undefined;
	let receipt: unknown;
	try {
		receipt = JSON.parse(value);
	} catch {
		// error-policy:J3 Noncanonical or malformed strings remain opaque.
		return undefined;
	}
	if (
		!isObjectRecord(receipt) ||
		JSON.stringify(receipt) !== value ||
		Object.entries(receipt).some(
			([key, field]) =>
				!NAVIGATION_RECEIPT_FIELDS.has(key) ||
				(typeof field !== "string" && field !== null),
		)
	)
		return undefined;
	return receipt;
}

type ShapeEntry = string | readonly [string, readonly string[]];
/** Fixed receipt shapes, so the legend never depends on which records are
 * shown. Shape 0 is the base; shape n adds RECEIPT_DETAILS[n] after it. A
 * receipt matching none of them is written as an object. */
const RECEIPT_BASE: readonly ShapeEntry[] = [
	"operation",
	["resource", ["kind", "id"]],
	"outcome",
];
const RECEIPT_DETAILS: readonly (ShapeEntry | undefined)[] = [
	undefined,
	"reason",
	["commit", ["kind"]],
	["failure", ["code", "retryable", "acceptance"]],
];
const SHAPE_KEYS = RECEIPT_DETAILS.map((detail) =>
	JSON.stringify(
		detail === undefined ? RECEIPT_BASE : [...RECEIPT_BASE, detail],
	),
);

/** The fields a later step reads: what was done (operation, outcome, reason,
 * failure, commit kind) and the record it was done to (resource kind and id,
 * child artifacts). Retry keys, observation times, store versions and receipt
 * identities bind proof inside the turn that produced it; the dialogue already
 * dates the request. A rollback names receipts by id, so a request holding one
 * keeps its receipt ids. */
function slimReceipt(receipt: EffectReceipt, receiptIds: boolean) {
	const slim: Record<string, unknown> = {};
	if (receiptIds) slim.receiptId = receipt.receiptId;
	slim.operation = receipt.operation;
	slim.resource = { kind: receipt.resource.kind, id: receipt.resource.id };
	if (receipt.artifacts.length)
		slim.artifacts = receipt.artifacts.map(({ kind, id }) => ({ kind, id }));
	slim.outcome = receipt.outcome;
	switch (receipt.outcome) {
		case "noop":
			slim.reason = receipt.reason;
			break;
		case "applied":
			slim.commit =
				receipt.commit.id === receipt.resource.id
					? { kind: receipt.commit.kind }
					: { kind: receipt.commit.kind, id: receipt.commit.id };
			break;
		case "failed":
			slim.failure = { ...receipt.failure };
			break;
		case "rolled_back":
			slim.rollback = {
				receiptId: receipt.rollback.receiptId,
				revertedReceiptIds: [...receipt.rollback.revertedReceiptIds],
				rolledBackAt: receipt.rollback.rolledBackAt,
			};
			break;
	}
	const keys = Object.entries(slim).map(([key, value]) =>
		isObjectRecord(value) ? [key, Object.keys(value)] : key,
	);
	const shape = SHAPE_KEYS.indexOf(JSON.stringify(keys));
	if (shape < 0) return slim;
	return [
		shape,
		Object.values(slim).map((value) =>
			isObjectRecord(value) ? Object.values(value) : value,
		),
	];
}

function slimNavigation(receipt: Record<string, unknown>) {
	return Object.fromEntries(
		Object.entries(receipt).filter(
			([key]) => !NAVIGATION_DROPPED_FIELDS.has(key),
		),
	);
}

/** A nested entry prints as the list its values take: resource -> [resourceKind,resourceId]. */
const template = (entry: ShapeEntry) =>
	typeof entry === "string"
		? entry
		: `[${entry[1].map((child) => entry[0] + child[0].toUpperCase() + child.slice(1)).join(",")}]`;
/** The legend says each rule once. Its record-kind rules (past outcomes only,
 * no new permission, no repeating completed work, a later reply failure leaves
 * committed effects) are the records' own scope, printed once beside it. */
const RECEIPT_ENCODING = `receipt=[shape,[${RECEIPT_BASE.map(template).join(",")}]]; ${RECEIPT_DETAILS.flatMap(
	(detail, shape) =>
		detail === undefined
			? []
			: [`${shape === 1 ? "shape " : ""}${shape} adds ${template(detail)}`],
).join(", ")}; other receipts are objects.`;
const NAVIGATION_ENCODING = "receipt is the recorded navigation object.";
const SOURCE_ENCODING = "history:hN names history source hN. Values are exact.";
/** A folded ending drops its own scope, so the legend says what an ending
 * means: a recorded end is a past outcome, never a claim about a resource's
 * current state. */
const PROPOSAL_ENCODING =
	"A preview records a proposal, not its completion; a later proposal state takes its place. A reason that says it never ran means the owner declined it or it expired: that answers whether the request ran, not what the resource holds now.";
const POSITION_ENCODING =
	"Each [id,row] segment with this id holds one row under this scope at its own chronological position.";

/** The fixed legend of one record kind: it depends only on the kind, its
 * columns and its scope, never on which records are shown. */
function legend(entry: Entry, positioned: boolean) {
	return {
		encoding: [
			`row=[requestSourceEventId,[[${entry.columns.join(",")}],...]];`,
			entry.field === "navigation" ? NAVIGATION_ENCODING : RECEIPT_ENCODING,
			SOURCE_ENCODING,
			...(entry.field === "outcomes" ? [PROPOSAL_ENCODING] : []),
			...(positioned ? [POSITION_ENCODING] : []),
		].join(" "),
		...(entry.scope === undefined ? {} : { scope: entry.scope }),
	};
}

function encodeRow(
	entry: Entry,
	sourceIds: ReadonlyMap<string, string> | undefined,
): [string, unknown[][]] {
	const label = sourceIds?.get(entry.request);
	const receiptIds = entry.receipts.some(
		(receipt) => receipt.outcome === "rolled_back",
	);
	return [
		label ? `history:${label}` : entry.request,
		entry.outcomes.map((outcome, index) =>
			entry.columns.map((column) => {
				if (column !== "receipt") return outcome[column];
				const receipt = entry.receipts[index];
				return entry.field === "navigation"
					? slimNavigation(receipt as Record<string, unknown>)
					: slimReceipt(receipt as EffectReceipt, receiptIds);
			}),
		),
	];
}

/** A later authoritative proposal state takes the place of the preview it
 * supersedes, in that preview's own row: a proposal ending rewrites one row
 * and adds none. Without exactly one matching preview it stays its own row. */
function foldProposalTerminals(
	segments: ContextObjectPromptSegment[],
	entries: (Entry | undefined)[],
): Set<number> {
	const folded = new Set<number>();
	segments.forEach((segment, index) => {
		const terminal = entries[index];
		const proposalId = segment.id?.startsWith(
			HISTORICAL_PROPOSAL_TERMINAL_ID_PREFIX,
		)
			? segment.id.slice(HISTORICAL_PROPOSAL_TERMINAL_ID_PREFIX.length)
			: undefined;
		if (
			!terminal ||
			!proposalId ||
			terminal.field !== "outcomes" ||
			terminal.outcomes.length !== 1
		)
			return;
		const matches: { entry: Entry; at: number }[] = [];
		entries.forEach((entry, other) => {
			if (
				!entry ||
				other === index ||
				folded.has(other) ||
				entry.field !== "outcomes" ||
				entry.request !== terminal.request ||
				segments[other].id?.startsWith(HISTORICAL_PROPOSAL_TERMINAL_ID_PREFIX)
			)
				return;
			entry.receipts.forEach((receipt, at) => {
				const preview = receipt as EffectReceipt;
				if (
					preview.outcome === "preview" &&
					preview.resource.kind === "device.approval" &&
					preview.resource.id === proposalId
				)
					matches.push({ entry, at });
			});
		});
		if (matches.length !== 1) return;
		const [{ entry, at }] = matches;
		if (JSON.stringify(entry.columns) !== JSON.stringify(terminal.columns))
			return;
		entry.outcomes = entry.outcomes.map((outcome, position) =>
			position === at ? terminal.outcomes[0] : outcome,
		);
		entry.receipts = entry.receipts.map((receipt, position) =>
			position === at ? terminal.receipts[0] : receipt,
		);
		folded.add(index);
	});
	return folded;
}

/** Notes about an earlier request that are not outcome records. */
const REQUEST_NOTE_LABELS: ReadonlySet<string> = new Set([
	"runtime:interrupted_turn",
	"runtime:historical_read_continuations",
]);

/** A request note names its request by the same history:hN key as that
 * request's records. A note for a request outside the shown sources, or one
 * not in exact canonical form, stays as it is. */
function relabelRequestNote(
	segment: ContextObjectPromptSegment,
	sourceIds: ReadonlyMap<string, string> | undefined,
): ContextObjectPromptSegment | undefined {
	if (
		!sourceIds?.size ||
		segment.stable ||
		!segment.label ||
		!REQUEST_NOTE_LABELS.has(segment.label)
	)
		return undefined;
	let note: unknown;
	try {
		note = JSON.parse(segment.content);
	} catch {
		// error-policy:J3 A malformed note stays unchanged on the wire.
		return undefined;
	}
	if (
		!isObjectRecord(note) ||
		JSON.stringify(note) !== segment.content ||
		typeof note.requestSourceEventId !== "string"
	)
		return undefined;
	const label = sourceIds.get(note.requestSourceEventId);
	return label
		? {
				...segment,
				content: JSON.stringify({
					...note,
					requestSourceEventId: `history:${label}`,
				}),
			}
		: undefined;
}

/** The source labels (hN) a request's history labels, reads and index use,
 * keyed by prior-dialogue event id. A label is a position in this request's
 * dialogue window, counted from its oldest message, so once a room outgrows
 * the window every label shifts on each new message. Empty when the sources
 * are ambiguous or the context carries no event list; records then keep their
 * event ids. */
export function historicalRequestSourceIds(
	context: ContextObject,
): Map<string, string> {
	if (!Array.isArray(context?.events)) return new Map();
	return new Map(
		collectCompletionContextSources(context).map(({ id, event }) => [
			event.id,
			id,
		]),
	);
}

export type HistoricalReceiptWireOptions = {
	/** Prior-dialogue event id (history:<message id>) to its source label hN
	 * in this request. A known request is written history:hN, the read
	 * reference and label this request already uses for it, and the same
	 * message's label moves when the dialogue window slides. */
	sourceIds?: ReadonlyMap<string, string>;
	/** positioned (default): a legend before each record group's first
	 * record, and every record at its own chronological position. table: one
	 * table per group at the group's first record, for a records region
	 * that is not interleaved with its requests. */
	layout?: "positioned" | "table";
};

/** Only runtime-authored typed receipt labels are eligible; never parse headings
 * inside dialogue/provider content. Original context events remain untouched.
 * Each record keeps the fields later steps read. A row depends only on its
 * record and its request's label, and a legend only on its record kind, so
 * the same input gives the same bytes. Inside the dialogue window a new record
 * only adds its row; once a room outgrows the window every label shifts (see
 * historicalRequestSourceIds), so the rows re-send from the first one.
 * Interrupted-turn and read-continuation notes name their request by the same
 * key.
 * Cost: bounded passes over receipt text; no I/O, retrieval or model calls. */
export function compactHistoricalReceiptSegments(
	segments: ContextObjectPromptSegment[],
	options: HistoricalReceiptWireOptions = {},
): ContextObjectPromptSegment[] {
	const entries = segments.map(recordEntry);
	const notes = segments.map((segment) =>
		relabelRequestNote(segment, options.sourceIds),
	);
	const folded = foldProposalTerminals(segments, entries);
	const groups = new Map<string, number[]>();
	let stableBoundary = 0;
	for (let index = 0; index < segments.length; index++) {
		if (segments[index].stable) stableBoundary++;
		const entry = entries[index];
		if (!entry || folded.has(index)) continue;
		const key = JSON.stringify([
			stableBoundary,
			entry.field,
			entry.columns,
			entry.scope,
		]);
		const members = groups.get(key);
		if (members) members.push(index);
		else groups.set(key, [index]);
	}
	if (groups.size === 0)
		return notes.some(Boolean)
			? segments.map((segment, index) => notes[index] ?? segment)
			: segments;
	const replacements = new Map<number, ContextObjectPromptSegment[]>();
	let referenceCounter = 0;
	for (const members of groups.values()) {
		const entry = entries[members[0]] as Entry;
		const rows = members.map((index) =>
			encodeRow(entries[index] as Entry, options.sourceIds),
		);
		if (options.layout === "table") {
			replacements.set(members[0], [
				{
					label: `${segments[members[0]].label}_table`,
					content: JSON.stringify({ ...legend(entry, false), rows }),
					stable: false,
				},
			]);
			for (const index of members.slice(1)) replacements.set(index, []);
			continue;
		}
		// Reserve a deterministic local namespace absent from every original segment
		// (including untrusted user text); a user cannot predeclare this reference.
		let reference: string;
		do {
			reference = `receipt_wire_${++referenceCounter}`;
		} while (segments.some((segment) => segment.content.includes(reference)));
		const header: ContextObjectPromptSegment = {
			id: reference,
			label: "runtime:historical_receipt_encoding",
			stable: false,
			content: JSON.stringify({ id: reference, ...legend(entry, true) }),
		};
		members.forEach((index, offset) => {
			const row: ContextObjectPromptSegment = {
				...segments[index],
				content: JSON.stringify([reference, rows[offset]]),
			};
			replacements.set(index, offset === 0 ? [header, row] : [row]);
		});
	}
	return segments.flatMap((segment, index) =>
		folded.has(index)
			? []
			: (replacements.get(index) ?? [notes[index] ?? segment]),
	);
}
