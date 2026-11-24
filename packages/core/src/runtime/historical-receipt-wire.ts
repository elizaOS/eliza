/** Wire-only text for the recorded outcomes of earlier requests. Original
 * context events remain authoritative for source selection, authorization and
 * restoration: nothing here is read back. */

import {
	type EffectReceipt,
	type FailedEffectReceipt,
	normalizeEffectReceipt,
} from "../types/effects";
import { isObjectRecord } from "../utils/type-guards";
import type { HistoricalEffectTerminal } from "./completion-context";
import { stableJsonStringify } from "./context-hash";
import type { ContextObjectPromptSegment } from "./context-object";
import { historyMessageStamp, segmentBlock } from "./context-renderer";

type RecordField = "outcomes" | "observations" | "navigation";

function receiptTableEntry(segment: ContextObjectPromptSegment) {
	const field: RecordField | undefined =
		segment.label === "runtime:historical_navigation"
			? "navigation"
			: segment.label === "runtime:historical_effects"
				? "outcomes"
				: segment.label === "runtime:historical_observations"
					? "observations"
					: undefined;
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
	const receipts = record[field];
	if (!Array.isArray(receipts) || receipts.length === 0) return undefined;
	const columns = Object.keys(receipts[0] ?? {});
	const allowedReceipt =
		field === "navigation"
			? ["success", "receipt"]
			: ["actionName", "success", "receipt"];
	if (
		!columns.includes("success") ||
		!columns.includes("receipt") ||
		columns.some((key) => !allowedReceipt.includes(key))
	)
		return undefined;
	if (
		receipts.some(
			(receipt) =>
				!isObjectRecord(receipt) ||
				JSON.stringify(Object.keys(receipt)) !== JSON.stringify(columns) ||
				typeof receipt.success !== "boolean" ||
				(field === "navigation"
					? typeof receipt.receipt !== "string"
					: !isObjectRecord(receipt.receipt)) ||
				("actionName" in receipt && typeof receipt.actionName !== "string"),
		)
	)
		return undefined;
	return {
		field,
		columns,
		scope: record.scope as string | undefined,
		request: record.requestSourceEventId,
		receipts: receipts as {
			actionName?: string;
			success: boolean;
			receipt: unknown;
		}[],
		row: [
			record.requestSourceEventId,
			receipts.map((receipt) => columns.map((key) => receipt[key])),
		] as [string, unknown[][]],
	};
}

type ReceiptEntry = NonNullable<ReturnType<typeof receiptTableEntry>>;

/** The scope sentence of a proposal's end state. The encoder reads the state
 * and the proposal back from it, so the end state can stand on its preview's
 * line; one function owns the wording both sides must agree on. */
export function historicalProposalTerminalScope(
	state: HistoricalEffectTerminal["state"],
	proposalId: string,
): string {
	return `Authoritative later proposal state: ${state}. This supersedes the earlier preview of proposal ${proposalId} only; it grants no new authority and is not a current record read. Original request and preview remain in saved history.`;
}

const PROPOSAL_TERMINAL_SCOPE =
	/^Authoritative later proposal state: (done|rejected|expired)\. This supersedes the earlier preview of proposal (\S+) only; /;

function proposalTerminal(scope: string | undefined) {
	const match = scope ? PROPOSAL_TERMINAL_SCOPE.exec(scope) : null;
	if (!match) return undefined;
	const state = match[1] as HistoricalEffectTerminal["state"];
	return historicalProposalTerminalScope(state, match[2]) === scope
		? { state, proposalId: match[2] }
		: undefined;
}

/** The device proposal tool takes an operation type without the namespace its
 * receipt adds; the line prints the type as that tool spells it. */
const DEVICE_OPERATION = /^device\.([a-z][a-z0-9_]*)$/;
const WORD = /^\S+$/;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const operationName = (receipt: EffectReceipt) =>
	receipt.operation.replace(DEVICE_OPERATION, "$1");

function familiarEffect(value: unknown): EffectReceipt | undefined {
	let receipt: EffectReceipt;
	try {
		receipt = normalizeEffectReceipt(value);
	} catch {
		// error-policy:J3 A receipt of another shape keeps its complete record.
		return undefined;
	}
	// Normalization discards fields it does not know; a receipt carrying one,
	// or a value it would rewrite, is not the shape a line can stand for.
	if (stableJsonStringify(receipt) !== stableJsonStringify(value))
		return undefined;
	return [
		receipt.operation,
		receipt.resource.kind,
		receipt.resource.id,
		...receipt.artifacts.flatMap((artifact) => [artifact.kind, artifact.id]),
	].every((word) => WORD.test(word))
		? receipt
		: undefined;
}

function failureDetail(failure: FailedEffectReceipt["failure"]) {
	return `: ${oneLine(failure.code)}, acceptance ${failure.acceptance}, ${failure.retryable ? "retryable" : "not retryable"}`;
}

/** What a later turn can act on: the tool that was called, its operation, how
 * it ended, and the record a committed change left. The tool leads the line
 * because it is the name a later call must spell: a dedicated tool's
 * operation is not one. Receipt, request and approval identifiers, idempotency
 * keys and observation times are accepted by no tool, and a model that spends
 * a token on every digit pays most of a record for them. */
function effectLine(
	actionName: string,
	success: boolean,
	receipt: EffectReceipt,
): string {
	const committed =
		receipt.outcome === "applied" ||
		receipt.outcome === "rolled_back" ||
		(receipt.outcome === "noop" && receipt.idempotency.replayed);
	// A failure whose acceptance is unknown may have reached its record: a
	// later check has to name it. A resource that only repeats the receipt's
	// own identity is no record.
	const unsettled =
		receipt.outcome === "failed" &&
		receipt.failure.acceptance === "unknown" &&
		receipt.resource.id !== receipt.receiptId;
	// A device approval or native operation identity names no record a tool
	// can open; a preview, read or rejected attempt left none.
	const records = (
		committed || unsettled ? [receipt.resource, ...receipt.artifacts] : []
	)
		.filter((record) => !record.kind.startsWith("device."))
		.map((record) => `${record.kind} ${record.id}`);
	const expected = receipt.outcome !== "failed";
	return [
		`${actionName} ${operationName(receipt)}`,
		` ${receipt.outcome}`,
		records.length ? ` ${records.join(", ")}` : "",
		receipt.outcome === "noop" ? `: ${oneLine(receipt.reason)}` : "",
		receipt.outcome === "failed" ? failureDetail(receipt.failure) : "",
		success === expected
			? ""
			: success
				? " (action succeeded)"
				: " (action failed)",
	].join("");
}

const NAVIGATION_FIELDS: ReadonlySet<string> = new Set([
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
const NAVIGATION_COMPLETED: ReadonlySet<string> = new Set([
	"delivered",
	"prepared",
]);

/** The view a later request can name and how the navigation ended. The step,
 * handoff and route path identify nothing a tool accepts. */
function navigationLine(success: boolean, value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	let receipt: unknown;
	try {
		receipt = JSON.parse(value);
	} catch {
		// error-policy:J3 Noncanonical or malformed strings remain opaque.
		return undefined;
	}
	if (
		JSON.stringify(receipt) !== value ||
		!isObjectRecord(receipt) ||
		Object.entries(receipt).some(
			([key, field]) =>
				!NAVIGATION_FIELDS.has(key) ||
				(typeof field !== "string" && field !== null),
		)
	)
		return undefined;
	const { effect, status, viewId, subview, label, resolvedAlias, reason } =
		receipt as Record<string, string | null | undefined>;
	if (
		!effect ||
		!status ||
		[effect, status, viewId, subview].some((word) => word && !WORD.test(word))
	)
		return undefined;
	const view = viewId ? `${viewId}${subview ? `/${subview}` : ""}` : "";
	return [
		`${effect} ${status}`,
		view ? ` ${view}` : "",
		label && label !== viewId ? ` ${JSON.stringify(label)}` : "",
		resolvedAlias ? ` (asked as ${JSON.stringify(resolvedAlias)})` : "",
		reason ? `: ${oneLine(reason)}` : "",
		success === NAVIGATION_COMPLETED.has(status)
			? ""
			: success
				? " (action succeeded)"
				: " (action failed)",
	].join("");
}

interface OutcomeRecord {
	index: number;
	segment: ContextObjectPromptSegment;
	field: RecordField;
	/** Records under one label and scope share one description. */
	group: string;
	scope: string | undefined;
	request: string;
	lines: string[];
}

/** Every record a line can stand for, with each proposal's end state folded
 * onto its preview's line: the proposal is one outcome, and a second record
 * for it costs a scope sentence that names it. A record of any other shape is
 * left to the table encoder below, which loses nothing. */
function outcomeRecords(segments: readonly ContextObjectPromptSegment[]) {
	const entries = segments.map(receiptTableEntry);
	const records = new Map<number, OutcomeRecord>();
	// A request that proposed one operation twice printed its preview twice.
	const previews = new Map<
		string,
		{ record: OutcomeRecord; line: number; called: string }[]
	>();
	const terminals: {
		index: number;
		entry: ReceiptEntry;
		state: HistoricalEffectTerminal["state"];
		proposalId: string;
	}[] = [];
	entries.forEach((entry, index) => {
		if (!entry) return;
		const terminal =
			entry.field === "outcomes" ? proposalTerminal(entry.scope) : undefined;
		if (terminal) {
			terminals.push({ index, entry, ...terminal });
			return;
		}
		const lines: string[] = [];
		const proposals: [string, number, string][] = [];
		for (const { actionName, success, receipt } of entry.receipts) {
			if (entry.field === "navigation") {
				const line = navigationLine(success, receipt);
				if (line === undefined) return;
				lines.push(line);
				continue;
			}
			const effect = familiarEffect(receipt);
			// A line names its tool; a record that names none keeps its form.
			if (!effect || !actionName || !WORD.test(actionName)) return;
			if (
				success &&
				effect.outcome === "preview" &&
				effect.resource.id === effect.receiptId
			)
				proposals.push([
					effect.receiptId,
					lines.length,
					`${actionName} ${operationName(effect)}`,
				]);
			lines.push(effectLine(actionName, success, effect));
		}
		const segment = segments[index];
		const record: OutcomeRecord = {
			index,
			segment,
			field: entry.field,
			group: JSON.stringify([segment.label, entry.scope]),
			scope: entry.scope,
			request: entry.request,
			lines,
		};
		records.set(index, record);
		for (const [proposalId, line, called] of proposals) {
			const key = JSON.stringify([entry.request, proposalId]);
			const shown = previews.get(key);
			if (shown) shown.push({ record, line, called });
			else previews.set(key, [{ record, line, called }]);
		}
	});
	const folded = new Set<number>();
	for (const { index, entry, state, proposalId } of terminals) {
		const key = JSON.stringify([entry.request, proposalId]);
		const shown = previews.get(key);
		const end =
			entry.receipts.length === 1
				? familiarEffect(entry.receipts[0].receipt)
				: undefined;
		// An end state with no preview in view keeps its complete record.
		if (!shown || !end) continue;
		// Only a carried-out proposal has more to say than its state: what the
		// phone reported doing.
		const detail =
			state !== "done"
				? ""
				: end.outcome === "noop"
					? `: ${oneLine(end.reason)}`
					: end.outcome === "failed"
						? failureDetail(end.failure)
						: "";
		// The line keeps the tool and operation its preview printed, whatever
		// the end state's own record names: one outcome, one name, on every turn.
		for (const preview of shown)
			preview.record.lines[preview.line] =
				`${preview.called} ${state}${detail}`;
		previews.delete(key);
		folded.add(index);
	}
	for (const index of [...records.keys(), ...folded])
		entries[index] = undefined;
	return { records, folded, tables: tabulateRecords(segments, entries) };
}

const MARKER: Readonly<Record<RecordField, string>> = {
	outcomes: "[outcome]",
	observations: "[read]",
	navigation: "[navigation]",
};
const RESULTS =
	"preview: proposed to the owner for review, not done. done, rejected, expired: how that review ended. applied: done. noop: read or checked, nothing changed.";

/** What a line of each kind says. `placed` is how the caller binds a line to
 * its request: a marked line below the request, or a line in a block. */
function lineFormat(field: RecordField, placed: "marked" | "block"): string {
	const line =
		placed === "marked" ? `Each ${MARKER[field]} line is` : "Each line is";
	const request =
		placed === "marked" ? "the request it follows" : "an earlier request";
	return field === "outcomes"
		? `${line} the recorded outcome of ${request}: tool, then operation, then result, then the record it changed when a later request can name one. ${RESULTS}`
		: field === "observations"
			? `${line} a read made for ${request}: tool, then operation, then result.`
			: `${line} a navigation made for ${request}: result, then the view.`;
}

/** A group's scope and line format are stated once, ahead of its first line.
 * The text depends on nothing but the group, so it stays byte-identical while
 * later outcomes are appended after it. */
function describeGroup(
	record: OutcomeRecord,
	placed: "marked" | "block",
): string[] {
	return [
		...(record.scope ? [oneLine(record.scope)] : []),
		lineFormat(record.field, placed),
	];
}

const block = (
	record: OutcomeRecord,
	lines: string[],
): ContextObjectPromptSegment => ({
	...record.segment,
	content: lines.join("\n"),
});

const NOT_SHOWN = "Outcomes of earlier requests that are not shown";
const SHOWN = "Outcomes of the requests shown above";

const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;
/** A line may open with whitespace or with characters that print nothing
 * (zero-width, direction and other format marks): it still reads as the words
 * that follow them. */
const BLANK_LINE = /^[\s\p{Cf}]*$/u;
/** How the runtime's own lines open: a marker, a message stamp, a block label
 * and the first words of the sentences that lead a block of outcome lines. */
const RUNTIME_LINE =
	/^[\s\p{Cf}]*(?:\[(?:outcome|read|navigation)\]|\[message_at=|runtime:[a-z_]+:|Each (?:\[(?:outcome|read|navigation)\] )?line is |Outcomes of (?:earlier requests|the requests shown) )/iu;

/** A historical message is someone's text, and the lines beside it are the
 * runtime's. A blank line inside the text would end the message's block and
 * let what follows stand as a block of its own, and a line of it could open as
 * the runtime's lines do. On the wire only, blank lines are dropped and such a
 * line is quoted, so everything a message says stays in its own block, visibly
 * its text. A message with neither keeps its bytes. */
function historicalMessageText(content: string): string {
	const lines = content.split(LINE_BREAK);
	if (
		!lines.some(
			(line, index) =>
				(index > 0 && BLANK_LINE.test(line)) || RUNTIME_LINE.test(line),
		)
	)
		return content;
	return lines
		.filter((line) => !BLANK_LINE.test(line))
		.map((line) => (RUNTIME_LINE.test(line) ? `> ${line}` : line))
		.join("\n");
}

function historicalMessage(
	segment: ContextObjectPromptSegment,
): ContextObjectPromptSegment {
	const label = segment.label;
	if (
		!label?.startsWith("prior_message:") &&
		!label?.startsWith("verified_cross_room_message:")
	)
		return segment;
	const content = historicalMessageText(segment.content);
	return content === segment.content ? segment : { ...segment, content };
}

/** Only runtime-authored typed receipt labels are eligible; never parse headings
 * inside dialogue/provider content. Original context events remain untouched.
 * Each outcome is one marked line directly below its request's message,
 * wherever its record stood, so a new one appends without moving earlier
 * text. A labelled block states each kind's scope and format ahead of its
 * first line, and holds the outcomes of requests that are not shown.
 * Cost: bounded passes over receipt and message text; no I/O, retrieval or
 * model calls. */
export function compactHistoricalReceiptSegments(
	segments: ContextObjectPromptSegment[],
): ContextObjectPromptSegment[] {
	const { records, folded, tables } = outcomeRecords(segments);
	const requests = new Map<string, number | undefined>();
	segments.forEach((segment, index) => {
		if (!segment.id || !segment.label?.startsWith("prior_message:")) return;
		// An identifier two messages share names neither of them.
		requests.set(segment.id, requests.has(segment.id) ? undefined : index);
	});
	const below = new Map<number, OutcomeRecord[]>();
	const groups = new Map<
		string,
		{ first: OutcomeRecord; at: number; unshown: OutcomeRecord[] }
	>();
	for (const record of records.values()) {
		const request = requests.get(record.request);
		// A group's description stands ahead of its first line, which is at its
		// request's message when the record came after it.
		const at = Math.min(request ?? record.index, record.index);
		const group = groups.get(record.group);
		if (!group)
			groups.set(record.group, {
				first: record,
				at,
				unshown: request === undefined ? [record] : [],
			});
		else {
			group.at = Math.min(group.at, at);
			if (request === undefined) group.unshown.push(record);
		}
		if (request === undefined) continue;
		const placed = below.get(request);
		if (placed) placed.push(record);
		else below.set(request, [record]);
	}
	const ahead = new Map<number, ContextObjectPromptSegment[]>();
	const lead = (at: number, record: OutcomeRecord, lines: string[]) => {
		const blocks = ahead.get(at) ?? [];
		ahead.set(at, blocks);
		blocks.push({
			label: record.segment.label,
			stable: false,
			content: lines.join("\n"),
		});
	};
	for (const { first, at, unshown } of groups.values()) {
		const description = describeGroup(first, "marked");
		const notShown = unshown.length
			? [`${NOT_SHOWN}:`, ...unshown.flatMap((each) => each.lines)]
			: [];
		// Both share one block when they stand at the same place.
		if (unshown[0]?.index === at)
			lead(at, first, [...description, ...notShown]);
		else {
			lead(at, first, description);
			if (unshown.length) lead(unshown[0].index, unshown[0], notShown);
		}
	}
	const output: ContextObjectPromptSegment[] = [];
	segments.forEach((segment, index) => {
		output.push(...(ahead.get(index) ?? []));
		if (!records.has(index) && !folded.has(index))
			output.push(...(tables.get(index) ?? [historicalMessage(segment)]));
		for (const each of below.get(index) ?? [])
			output.push({
				...each.segment,
				label: undefined,
				content: each.lines
					.map((line) => `${MARKER[each.field]} ${line}`)
					.join("\n"),
			});
	});
	return output;
}

/** The same lines for a caller that renders its transcript as one block: the
 * outcomes of the requests it shows go after that block, each line keyed by
 * the stamp its request carries there, and nothing sits between two messages
 * where a message's own text could pass for an outcome. `before` holds every
 * other segment in order, with the outcomes of requests that are not shown.
 * `transcript` is the one to render: a request whose stamp an earlier one
 * already carries shows its number at that stamp, so each key names one
 * request, and an earlier line never changes for a later request. A request
 * with no stamp has no key, and its outcomes stand with those of requests not
 * shown.
 * `historySources` maps a request's event to the reference a history read
 * takes, when one is offered. */
export function historicalOutcomeBlocks(
	segments: ContextObjectPromptSegment[],
	dialogue: readonly ContextObjectPromptSegment[],
	historySources?: ReadonlyMap<string, string>,
): {
	before: ContextObjectPromptSegment[];
	transcript: ContextObjectPromptSegment[];
	after: ContextObjectPromptSegment[];
} {
	const { records, folded, tables } = outcomeRecords(segments);
	const stamped = new Map<string, number>();
	const keys = new Map<string, string | undefined>();
	const transcript = dialogue.map((segment) => {
		const message = historicalMessage(segment);
		if (message.label !== "prior_message:user") return message;
		const stamp = historyMessageStamp(message);
		if (!stamp) return message;
		const ordinal = (stamped.get(stamp) ?? 0) + 1;
		stamped.set(stamp, ordinal);
		const request =
			ordinal === 1
				? message
				: {
						...message,
						metadata: { ...message.metadata, displayOrdinal: ordinal },
					};
		// An identifier two messages share names neither of them.
		if (request.id)
			keys.set(
				request.id,
				keys.has(request.id) ? undefined : historyMessageStamp(request),
			);
		return request;
	});
	const groups = new Map<
		string,
		{ unshown: OutcomeRecord[]; shown: [OutcomeRecord, string[]][] }
	>();
	for (const record of records.values()) {
		const group = groups.get(record.group) ?? { unshown: [], shown: [] };
		groups.set(record.group, group);
		const key = keys.get(record.request);
		if (key === undefined) {
			group.unshown.push(record);
			continue;
		}
		group.shown.push([record, record.lines.map((line) => `${key} ${line}`)]);
	}
	const before: ContextObjectPromptSegment[] = [];
	segments.forEach((segment, index) => {
		const record = records.get(index);
		if (!record) {
			if (!folded.has(index)) before.push(...(tables.get(index) ?? [segment]));
			return;
		}
		const group = groups.get(record.group);
		if (group?.unshown[0] !== record) return;
		const keyed = historySources
			? group.unshown.some((each) => historySources.has(each.request))
			: false;
		before.push(
			block(record, [
				...describeGroup(record, "block"),
				keyed
					? `${NOT_SHOWN}, each line after the history source that holds its request:`
					: `${NOT_SHOWN}:`,
				...group.unshown.flatMap((each) => {
					const source = historySources?.get(each.request);
					return each.lines.map((line) =>
						source ? `${source} ${line}` : line,
					);
				}),
			]),
		);
	});
	const after: ContextObjectPromptSegment[] = [];
	for (const group of groups.values()) {
		const first = group.shown[0]?.[0];
		if (!first) continue;
		after.push(
			block(first, [
				...(group.unshown.length ? [] : describeGroup(first, "block")),
				`${SHOWN}, each line after its request's message_at time:`,
				...group.shown.flatMap(([, lines]) => lines),
			]),
		);
	}
	return { before, transcript, after };
}

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
]);
const EFFECT_RECEIPT_FIELDS: ReadonlySet<string> = new Set([
	"receiptId",
	"operation",
	"resource",
	"artifacts",
	"idempotency",
	"observedAt",
	"outcome",
	"reason",
	"commit",
	"failure",
	"rollback",
]);
const NESTED_RECEIPT_FIELDS: ReadonlySet<string> = new Set([
	"resource",
	"idempotency",
	"commit",
	"failure",
	"rollback",
]);

/** One encoder owns both contiguous tables and position-preserving rows. */
function encodeReceiptTable(entry: ReceiptEntry, rows: ReceiptEntry["row"][]) {
	const table = {
		encoding:
			"Each row uses columns; nested receipt rows use receiptColumns. Preserve order. Values are exact; shared scope applies to every row.",
		columns: ["requestSourceEventId", entry.field],
		receiptColumns: entry.columns,
		...(entry.scope === undefined ? {} : { scope: entry.scope }),
	};
	let content = JSON.stringify({ ...table, rows });
	const receiptIndex = entry.columns.indexOf("receipt");
	const navigation = entry.field === "navigation";
	const allowedFields = navigation
		? NAVIGATION_RECEIPT_FIELDS
		: EFFECT_RECEIPT_FIELDS;
	// Keep the existing flat encodings as candidates. Nested field-name sharing
	// wins only when its complete wire, including decoding instructions, is smaller.
	// Cost: two bounded receipt passes; no I/O, source omission or model calls.
	for (const packNested of navigation ? [false] : [false, true]) {
		const receiptShapes: (string | [string, string[]])[][] = [];
		const shapeIndices = new Map<string, number>();
		const encodedReceipts: unknown[] = [];
		let packable = true;
		for (const [, receipts] of rows) {
			for (const receipt of receipts) {
				const original = receipt[receiptIndex];
				let object = original;
				if (navigation) {
					try {
						object = JSON.parse(String(original));
					} catch {
						// error-policy:J3 Noncanonical or malformed strings remain opaque.
						packable = false;
						break;
					}
					if (JSON.stringify(object) !== original) {
						packable = false;
						break;
					}
				}
				if (
					!isObjectRecord(object) ||
					Object.keys(object).some((key) => !allowedFields.has(key))
				) {
					packable = false;
					break;
				}
				const keys = Object.keys(object).map((key) =>
					packNested &&
					NESTED_RECEIPT_FIELDS.has(key) &&
					isObjectRecord(object[key]) &&
					Object.keys(object[key]).length > 0
						? ([key, Object.keys(object[key])] as [string, string[]])
						: key,
				);
				const shapeKey = JSON.stringify(keys);
				let shapeIndex = shapeIndices.get(shapeKey);
				if (shapeIndex === undefined) {
					shapeIndex = receiptShapes.length;
					receiptShapes.push(keys);
					shapeIndices.set(shapeKey, shapeIndex);
				}
				encodedReceipts.push([
					shapeIndex,
					keys.map((key) =>
						typeof key === "string"
							? object[key]
							: Object.values(object[key[0]] as Record<string, unknown>),
					),
				]);
			}
			if (!packable) break;
		}
		if (!packable) break;
		let receiptOffset = 0;
		const packed = {
			...table,
			receiptEncoding:
				(navigation
					? "receipt=[shapeIndex,values]; receiptShapes gives exact property order. Reconstruct the original receipt string with JSON.stringify(Object.fromEntries(columns paired with values)). Only canonical JSON strings are encoded; every value is exact."
					: "receipt=[shapeIndex,values]; receiptShapes gives property order. Pair columns with values to reconstruct the complete original receipt object. Every value is exact.") +
				(packNested && receiptShapes.some((shape) => shape.some(Array.isArray))
					? " A string shape entry copies its corresponding value unchanged, including arrays and objects. A [fieldName,childColumns] shape entry pairs the corresponding child value array with those columns to reconstruct that complete nested object in property order."
					: ""),
			receiptShapes,
			rows: rows.map(([requestSourceEventId, receipts]) => [
				requestSourceEventId,
				receipts.map((receipt) =>
					receipt.map((value, column) =>
						column === receiptIndex ? encodedReceipts[receiptOffset++] : value,
					),
				),
			]),
		};
		const candidate = JSON.stringify(packed);
		if (candidate.length < content.length) content = candidate;
		// Repeated receipt values keep independent request bindings and positions.
		// References always point to the first complete earlier receipt, never to
		// another reference. Compare the entire encoding including its instructions.
		const firstReceipts = new Map<string, number>();
		let position = 0;
		const referenced = {
			...packed,
			receiptEncoding:
				packed.receiptEncoding +
				" A one-item receipt [n] repeats the complete receipt at zero-based receipt position n earlier in this table (including rows sharing its legend). Each occurrence retains its own source and position.",
			rows: packed.rows.map(([source, receipts]) => [
				source,
				(receipts as unknown[][]).map((receipt) =>
					receipt.map((value, column) => {
						if (column !== receiptIndex) return value;
						const key = JSON.stringify(value);
						const first = firstReceipts.get(key);
						const current = position++;
						if (first !== undefined) return [first];
						firstReceipts.set(key, current);
						return value;
					}),
				),
			]),
		};
		const referenceCandidate = JSON.stringify(referenced);
		if (referenceCandidate.length < content.length)
			content = referenceCandidate;
	}
	return JSON.parse(content) as {
		encoding: string;
		columns: string[];
		receiptColumns: string[];
		scope?: string;
		rows: ReceiptEntry["row"][];
		receiptEncoding?: string;
		receiptShapes?: (string | [string, string[]])[][];
	};
}

/** Complete tables for the records no line can stand for: a receipt of an
 * unfamiliar shape, or an end state whose preview is not in view. Keep
 * contiguous tables when cheaper; interleaved rows retain their segment
 * identity, metadata, label and position with an in-prompt shared legend. */
function tabulateRecords(
	segments: readonly ContextObjectPromptSegment[],
	entries: readonly (ReceiptEntry | undefined)[],
): Map<number, ContextObjectPromptSegment[]> {
	const groups = new Map<string, { index: number; entry: ReceiptEntry }[]>();
	let stableBoundary = 0;
	for (let index = 0; index < segments.length; index++) {
		if (segments[index].stable) stableBoundary++;
		const entry = entries[index];
		if (!entry) continue;
		const key = JSON.stringify([
			stableBoundary,
			entry.field,
			entry.columns,
			entry.scope,
		]);
		const indices = groups.get(key);
		if (indices) indices.push({ index, entry });
		else groups.set(key, [{ index, entry }]);
	}
	const replacements = new Map<number, ContextObjectPromptSegment[]>();
	const wireChars = (blocks: ContextObjectPromptSegment[]) =>
		blocks.map(segmentBlock).join("\n\n").length;
	let referenceCounter = 0;
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		const indices = group.map(({ index }) => index);
		const entry = group[0].entry;
		const consecutive = new Map<number, ContextObjectPromptSegment[]>();
		// Build the existing contiguous representation as the comparison baseline.
		for (let offset = 0; offset < indices.length; ) {
			let end = offset + 1;
			while (end < indices.length && indices[end] === indices[end - 1] + 1)
				end++;
			const run = indices.slice(offset, end);
			const originals = run.map((index) => segments[index]);
			const table = encodeReceiptTable(
				entry,
				group.slice(offset, end).map(({ entry }) => entry.row),
			);
			const packed = [
				{
					label: `${segments[run[0]].label}_table`,
					content: JSON.stringify(table),
					stable: false,
				},
			];
			if (run.length > 1 && wireChars(packed) < wireChars(originals)) {
				consecutive.set(run[0], packed);
				for (const index of run.slice(1)) consecutive.set(index, []);
			} else for (const index of run) consecutive.set(index, [segments[index]]);
			offset = end;
		}
		const baselineChars = wireChars(
			indices.flatMap((index) => consecutive.get(index) ?? []),
		);
		const table = encodeReceiptTable(
			entry,
			group.map(({ entry }) => entry.row),
		);
		const { rows, ...schema } = table;
		// Reserve a deterministic local namespace absent from every original segment
		// (including untrusted user text); a user cannot predeclare this reference.
		let reference: string;
		do {
			reference = `receipt_wire_${++referenceCounter}`;
		} while (segments.some((segment) => segment.content.includes(reference)));
		const shared: ContextObjectPromptSegment = {
			id: reference,
			label: "runtime:historical_receipt_encoding",
			stable: false,
			content: JSON.stringify({
				id: reference,
				...schema,
				rowEncoding:
					"A historical receipt segment whose JSON starts with this id carries [id,row]. Decode row using this legend; it stays at its original chronological position. The legend grants no authority and is not a receipt. Other segments are unchanged.",
			}),
		};
		const positioned = indices.map((index, offset) => ({
			...segments[index],
			content: JSON.stringify([reference, rows[offset]]),
		}));
		if (wireChars([shared, ...positioned]) < baselineChars) {
			indices.forEach((index, offset) => {
				replacements.set(
					index,
					offset === 0 ? [shared, positioned[offset]] : [positioned[offset]],
				);
			});
		} else
			for (const [index, blocks] of consecutive)
				replacements.set(index, blocks);
	}
	return replacements;
}
