/**
 * Parse interaction blocks out of message text. This is a connector-agnostic
 * superset of the dashboard's per-feature parsers (`message-choice-parser`,
 * `message-form-parser`, `message-task-parser`, `message-followups-parser`) so
 * the exact same agent output renders identically on every surface.
 *
 * Wire markers:
 *   [FORM]\n{json}\n[/FORM]
 *   [CHOICE:<scope>( id=<id>)?]\n value=label …\n[/CHOICE]
 *   [FOLLOWUPS( id=<id>)?]\n <kind>:<payload>=<label> …\n[/FOLLOWUPS]
 *   [TASK:<threadId>]<title>[/TASK]
 *
 * Parsing is intentionally strict: a malformed block is left as plain text
 * rather than rendered as a broken control.
 */

import type {
	ChoiceInteraction,
	FollowupKind,
	FollowupOption,
	FollowupsInteraction,
	FormInteraction,
	InteractionBlock,
	InteractionField,
	InteractionFieldType,
	InteractionOption,
	TaskInteraction,
} from "../../types/interactions";
import { stripDashboardOnlyMarkers } from "./dashboard-markers";

/** Hard caps mirroring the dashboard parsers — keep a runaway template safe. */
export const MAX_FORM_FIELDS = 20;
export const MAX_FOLLOWUPS = 4;
export const MAX_TASK_TITLE_LEN = 200;

const FIELD_TYPES: ReadonlySet<InteractionFieldType> = new Set([
	"text",
	"number",
	"select",
	"checkbox",
	"secret",
	"image",
	"file",
	"date",
	"time",
	"datetime",
]);
const UNSAFE_OBJECT_FIELD_NAMES: ReadonlySet<string> = new Set([
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
	"__proto__",
	"constructor",
	"hasOwnProperty",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"toLocaleString",
	"toString",
	"valueOf",
]);
const FOLLOWUP_KINDS: ReadonlySet<FollowupKind> = new Set([
	"reply",
	"navigate",
	"prompt",
]);

/** A parsed block together with the character region it occupied in the text. */
export interface InteractionRegion {
	start: number;
	end: number;
	block: InteractionBlock;
}

function randomId(prefix: string): string {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID();
	}
	return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** `value=label` lines → options (shared by CHOICE). */
function parseOptionLines(body: string): InteractionOption[] {
	const options: InteractionOption[] = [];
	for (const rawLine of body.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const value = line.slice(0, eq).trim();
		const label = line.slice(eq + 1).trim();
		if (!value || !label) continue;
		options.push({ value, label });
	}
	return options;
}

function parseFollowupLines(body: string): FollowupOption[] {
	const options: FollowupOption[] = [];
	for (const rawLine of body.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		if (options.length >= MAX_FOLLOWUPS) break;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const head = line.slice(0, eq);
		const label = line.slice(eq + 1).trim();
		const colon = head.indexOf(":");
		let kind: FollowupKind = "reply";
		let payload = head.trim();
		if (colon > 0) {
			const maybe = head.slice(0, colon).trim().toLowerCase();
			if (FOLLOWUP_KINDS.has(maybe as FollowupKind)) {
				kind = maybe as FollowupKind;
				payload = head.slice(colon + 1).trim();
			}
		}
		if (!payload || !label) continue;
		options.push({ kind, payload, label });
	}
	return options;
}

function parseFormField(raw: unknown): InteractionField | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const name = typeof r.name === "string" ? r.name.trim() : "";
	const type =
		typeof r.type === "string" ? (r.type as InteractionFieldType) : "text";
	if (!name || !/^[\w.-]+$/.test(name) || UNSAFE_OBJECT_FIELD_NAMES.has(name)) {
		return null;
	}
	if (!FIELD_TYPES.has(type)) return null;
	const field: InteractionField = { name, type };
	if (typeof r.label === "string") field.label = r.label;
	if (typeof r.placeholder === "string") field.placeholder = r.placeholder;
	if (typeof r.required === "boolean") field.required = r.required;
	if (type === "select" && Array.isArray(r.options)) {
		const opts: InteractionOption[] = [];
		for (const o of r.options) {
			if (o && typeof o === "object") {
				const oo = o as Record<string, unknown>;
				if (typeof oo.value === "string" && typeof oo.label === "string") {
					opts.push({ value: oo.value, label: oo.label });
				}
			}
		}
		field.options = opts;
	}
	if (type === "image" || type === "file") {
		if (Array.isArray(r.mimeTypes)) {
			const mimes = r.mimeTypes.filter(
				(m): m is string => typeof m === "string",
			);
			if (mimes.length > 0) field.mimeTypes = mimes;
		}
		if (typeof r.maxBytes === "number" && r.maxBytes > 0) {
			field.maxBytes = r.maxBytes;
		}
	}
	return field;
}

function parseFormBody(body: string): FormInteraction | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body.trim());
	} catch {
		// error-policy:J3 interaction bodies are untrusted transport input;
		// malformed JSON is an explicit invalid form.
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const p = parsed as Record<string, unknown>;
	if (!Array.isArray(p.fields)) return null;
	const fields: InteractionField[] = [];
	for (const raw of p.fields) {
		if (fields.length >= MAX_FORM_FIELDS) break;
		const field = parseFormField(raw);
		if (field) fields.push(field);
	}
	if (fields.length === 0) return null;
	const form: FormInteraction = {
		kind: "form",
		id: typeof p.id === "string" && p.id ? p.id : randomId("form"),
		submitLabel: typeof p.submitLabel === "string" ? p.submitLabel : "Submit",
		fields,
	};
	if (typeof p.title === "string") form.title = p.title;
	if (typeof p.description === "string") form.description = p.description;
	return form;
}

type MarkerKind = "CHOICE" | "FOLLOWUPS" | "FORM" | "TASK";

interface ParsedMarker {
	kind: MarkerKind;
	closing: boolean;
	rest: string;
}

interface RawInteractionRegion {
	start: number;
	end: number;
	kind: MarkerKind;
	header: string;
	body: string;
}

interface ActiveMarker {
	start: number;
	bodyStart: number;
	marker: ParsedMarker;
}

function scanMarkerEnd(
	text: string,
	start: number,
): { end: number } | { nested: number } | null {
	for (let cursor = start + 1; cursor < text.length; cursor += 1) {
		if (text[cursor] === "[") return { nested: cursor };
		if (text[cursor] === "]") return { end: cursor };
	}
	return null;
}

function parseMarker(value: string): ParsedMarker | null {
	let cursor = 0;
	while (cursor < value.length && /[ \t]/.test(value[cursor])) cursor += 1;
	let closing = false;
	if (value[cursor] === "/") {
		closing = true;
		cursor += 1;
		while (cursor < value.length && /[ \t]/.test(value[cursor])) cursor += 1;
	}
	const nameStart = cursor;
	while (cursor < value.length && /[A-Za-z]/.test(value[cursor])) cursor += 1;
	const kind = value.slice(nameStart, cursor).toUpperCase() as MarkerKind;
	if (!["CHOICE", "FOLLOWUPS", "FORM", "TASK"].includes(kind)) return null;
	return { kind, closing, rest: value.slice(cursor).trim() };
}

function isValidOpeningMarker(marker: ParsedMarker): boolean {
	if (marker.closing) return false;
	if (marker.kind === "FORM") return marker.rest === "";
	if (marker.kind === "FOLLOWUPS") {
		if (marker.rest === "") return true;
		if (!marker.rest.startsWith("id=") || marker.rest.length === 3)
			return false;
		for (let cursor = 3; cursor < marker.rest.length; cursor += 1) {
			if (/\s/u.test(marker.rest[cursor])) return false;
		}
		return true;
	}
	if (!marker.rest.startsWith(":")) return false;
	const header = marker.rest.slice(1).trim();
	if (marker.kind === "TASK") return /^[a-f0-9-]{8,64}$/.test(header);
	const space = header.search(/[ \t]/);
	const scope = space < 0 ? header : header.slice(0, space);
	return scope.length > 0 && /^[\w-]+$/.test(scope);
}

function scanRawInteractionRegions(text: string): RawInteractionRegion[] {
	const regions: RawInteractionRegion[] = [];
	const active = new Map<MarkerKind, ActiveMarker>();
	let cursor = 0;
	while (cursor < text.length) {
		const start = text.indexOf("[", cursor);
		if (start < 0) break;
		const scanned = scanMarkerEnd(text, start);
		if (!scanned) break;
		if ("nested" in scanned) {
			cursor = scanned.nested;
			continue;
		}
		const bracketEnd = scanned.end;
		const marker = parseMarker(text.slice(start + 1, bracketEnd));
		cursor = bracketEnd + 1;
		if (!marker) {
			continue;
		}
		if (!marker.closing) {
			if (!isValidOpeningMarker(marker) || active.has(marker.kind)) continue;
			let bodyStart = bracketEnd + 1;
			if (marker.kind !== "TASK") {
				while (bodyStart < text.length && /[ \t]/.test(text[bodyStart]))
					bodyStart += 1;
				if (text[bodyStart] === "\r") bodyStart += 1;
				if (text[bodyStart] !== "\n") continue;
				bodyStart += 1;
			}
			active.set(marker.kind, { start, bodyStart, marker });
			continue;
		}
		if (marker.rest !== "") continue;
		const opening = active.get(marker.kind);
		if (!opening) continue;
		if (marker.kind !== "TASK" && text[start - 1] !== "\n") continue;
		active.delete(marker.kind);
		let bodyEnd = start;
		if (marker.kind !== "TASK" && text[bodyEnd - 1] === "\n") {
			bodyEnd -= 1;
			if (text[bodyEnd - 1] === "\r") bodyEnd -= 1;
		}
		regions.push({
			start: opening.start,
			end: bracketEnd + 1,
			kind: marker.kind,
			header: opening.marker.rest,
			body: text.slice(opening.bodyStart, bodyEnd),
		});
	}
	return regions;
}

/** Find every interaction-block region in `text`, sorted by position, de-overlapped. */
export function findInteractionRegions(text: string): InteractionRegion[] {
	if (!text) return [];
	const regions: InteractionRegion[] = [];
	for (const raw of scanRawInteractionRegions(text)) {
		let block: InteractionBlock | null = null;
		if (raw.kind === "CHOICE") {
			const header = raw.header.startsWith(":")
				? raw.header.slice(1).trim()
				: "";
			const space = header.search(/[ \t]/);
			const scope = space < 0 ? header : header.slice(0, space);
			const attrs = space < 0 ? "" : header.slice(space + 1);
			if (!scope || !/^[\w-]+$/.test(scope)) continue;
			const options = parseOptionLines(raw.body);
			if (options.length === 0) continue;
			const id = attrs.match(/\bid=(\S+)/)?.[1] ?? randomId("choice");
			const choice: ChoiceInteraction = {
				kind: "choice",
				id,
				scope,
				options,
			};
			if (attrs.split(/\s+/).includes("allow_custom"))
				choice.allowCustom = true;
			block = choice;
		} else if (raw.kind === "FOLLOWUPS") {
			const options = parseFollowupLines(raw.body);
			if (options.length === 0) continue;
			const idPart = raw.header
				.split(/\s+/)
				.find((part) => part.startsWith("id="));
			block = {
				kind: "followups",
				id: idPart?.slice(3) || randomId("followups"),
				options,
			} satisfies FollowupsInteraction;
		} else if (raw.kind === "FORM") {
			if (raw.header !== "") continue;
			block = parseFormBody(raw.body);
		} else {
			const threadId = raw.header.startsWith(":")
				? raw.header.slice(1).trim()
				: "";
			const rawTitle = raw.body.trim();
			if (!/^[a-f0-9-]{8,64}$/.test(threadId) || !rawTitle) continue;
			const title =
				rawTitle.length > MAX_TASK_TITLE_LEN
					? `${rawTitle.slice(0, MAX_TASK_TITLE_LEN - 1)}…`
					: rawTitle;
			block = { kind: "task", threadId, title } satisfies TaskInteraction;
		}
		if (block) regions.push({ start: raw.start, end: raw.end, block });
	}

	regions.sort((a, b) => a.start - b.start);
	// Drop any region that overlaps one already accepted (left-to-right wins).
	const accepted: InteractionRegion[] = [];
	let cursor = 0;
	for (const r of regions) {
		if (r.start < cursor) continue;
		accepted.push(r);
		cursor = r.end;
	}
	return accepted;
}

export interface ParsedInteractions {
	/** Blocks in document order. */
	blocks: InteractionBlock[];
	/** Message text with every block marker removed and whitespace tidied. */
	cleanedText: string;
}

function isUnclaimedMarkerLine(line: string): boolean {
	const value = line.trim();
	if (!value.startsWith("[") || !value.endsWith("]")) return false;
	let cursor = 1;
	while (/[ \t]/.test(value[cursor] ?? "")) cursor += 1;
	if (value[cursor] === "/") cursor += 1;
	while (/[ \t]/.test(value[cursor] ?? "")) cursor += 1;
	const nameStart = cursor;
	while (/[A-Z_-]/.test(value[cursor] ?? "")) cursor += 1;
	if (cursor === nameStart || !/[A-Z]/.test(value[nameStart])) return false;
	while (cursor < value.length - 1 && value[cursor] !== ":") {
		if (!/[ \t]/.test(value[cursor])) return false;
		cursor += 1;
	}
	return value[cursor] === ":" || cursor === value.length - 1;
}

function isUnclaimedOptionLine(line: string): boolean {
	const value = line.trim();
	const equals = value.indexOf("=");
	if (equals < 1 || equals > 256 || equals === value.length - 1) return false;
	const colon = value.indexOf(":");
	if (colon >= 0 && colon < equals) {
		const kind = value.slice(0, colon).trim().toLowerCase();
		if (
			!["reply", "navigate", "prompt", "value", "action", "url"].includes(kind)
		) {
			return false;
		}
	}
	return true;
}

function isUnclaimedOpeningLine(line: string): boolean {
	const value = line.trim();
	if (!value.startsWith("[")) return false;
	const end = value.indexOf("]");
	if (end < 0) return false;
	const marker = parseMarker(value.slice(1, end));
	if (!marker || marker.closing) return false;
	if (marker.kind === "TASK") return true;
	return (
		(marker.kind === "FOLLOWUPS" || marker.kind === "CHOICE") &&
		value.slice(end + 1).trim() === ""
	);
}

interface SourceLine {
	start: number;
	end: number;
	text: string;
	inFence: boolean;
}

function sourceLines(text: string): SourceLine[] {
	const lines: SourceLine[] = [];
	let fence: "`" | "~" | null = null;
	let start = 0;
	while (start < text.length) {
		const newline = text.indexOf("\n", start);
		const end = newline < 0 ? text.length : newline + 1;
		const line = text.slice(start, newline < 0 ? text.length : newline);
		const fenceMatch = line.match(/^[ \t]*(`{3,}|~{3,})/);
		const marker = fenceMatch?.[1]?.[0] as "`" | "~" | undefined;
		const inFence = fence !== null || marker !== undefined;
		lines.push({
			start,
			end,
			text: line,
			inFence,
		});
		if (marker !== undefined) {
			fence = fence === null ? marker : fence === marker ? null : fence;
		}
		start = end;
	}
	return lines;
}

/**
 * Remove only a terminal, unclaimed interaction suffix from model output.
 * Valid blocks remain untouched for renderers, FORM residue is preserved
 * because it can contain user data, and fenced examples are never rewritten.
 */
function stripUnclaimedInteractionMarkupTail(text: string): string {
	const upper = text.toUpperCase();
	if (
		!upper.includes("FOLLOWUPS") &&
		!upper.includes("CHOICE") &&
		!upper.includes("TASK")
	)
		return text;
	const lines = sourceLines(text);
	let suffixStart = lines.length;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (line.inFence) break;
		if (
			line.text.trim().length === 0 ||
			isUnclaimedOptionLine(line.text) ||
			isUnclaimedMarkerLine(line.text)
		) {
			suffixStart = index;
			continue;
		}
		break;
	}
	if (suffixStart >= lines.length) return text;
	let opening = -1;
	for (let index = suffixStart; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line.inFence && isUnclaimedOpeningLine(line.text)) {
			opening = index;
			break;
		}
	}
	if (opening < 0) return text;
	return text.slice(0, lines[opening].start).trimEnd();
}

/** Preserve claimable controls while removing a terminal unclaimed suffix. */
export function stripUnclaimedInteractionMarkup(text: string): string {
	const upper = text.toUpperCase();
	if (
		!upper.includes("FOLLOWUPS") &&
		!upper.includes("CHOICE") &&
		!upper.includes("TASK")
	)
		return text;
	const terminalClaim = findInteractionRegions(text).some(
		(region) => text.slice(region.end).trim().length === 0,
	);
	return terminalClaim ? text : stripUnclaimedInteractionMarkupTail(text);
}

/**
 * Parse `text` into its interaction blocks plus the human-readable text with
 * the markers stripped. The cleaned text is what a connector shows above the
 * native controls it renders from `blocks`.
 */
export function parseInteractionBlocks(text: string): ParsedInteractions {
	const regions = findInteractionRegions(text);
	if (regions.length === 0) {
		return {
			blocks: [],
			cleanedText: stripDashboardOnlyMarkers(
				stripUnclaimedInteractionMarkup(text),
			),
		};
	}
	const blocks: InteractionBlock[] = [];
	const parts: string[] = [];
	let cursor = 0;
	for (const r of regions) {
		if (r.start > cursor) parts.push(text.slice(cursor, r.start));
		blocks.push(r.block);
		cursor = r.end;
	}
	if (cursor < text.length) parts.push(text.slice(cursor));
	const cleanedText = stripDashboardOnlyMarkers(
		stripUnclaimedInteractionMarkup(parts.join(""))
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
	);
	return { blocks, cleanedText };
}

/** True when `text` contains at least one interaction block. */
export function hasInteractionBlocks(text: string): boolean {
	return findInteractionRegions(text).length > 0;
}
