/**
 * Serializes genuine provider deltas into prefix-stable user-visible commits.
 * The gate holds ambiguous machine syntax and structured control payloads,
 * preserves explicitly requested safe JSON byte-for-byte, and makes abort or
 * policy failure irreversible once an observer has seen a prefix.
 */

import { classifyCompactUserVisibleControlDialect } from "../../runtime/user-visible-control-dialect";
import { containsExternalEnvelopeMaterial } from "../../security/external-content";
import { isAbbreviationPeriod } from "../../utils/text-splitting";
import { isSafeUserVisibleJsonText } from "./outbound-sanitize";

export const MAX_COMMITTED_REPLY_SOURCE_CHARS = 256_000;

export type CommittedReplyBlockReason =
	| "external_envelope"
	| "internal_control";

export type CommittedReplyStreamState =
	| "open"
	| "complete"
	| "aborted"
	| "blocked"
	| "failed";

export class CommittedReplyProtocolError extends Error {
	readonly code = "COMMITTED_REPLY_PROTOCOL_ERROR";
	readonly retryable = false;
	readonly cause?: unknown;
	readonly recoverableCommittedPrefix: boolean;

	constructor(
		message: string,
		cause?: unknown,
		options?: { recoverableCommittedPrefix?: boolean },
	) {
		super(message);
		this.name = "CommittedReplyProtocolError";
		this.cause = cause;
		this.recoverableCommittedPrefix =
			options?.recoverableCommittedPrefix === true;
	}
}

/**
 * A committed prefix could not be delivered to its authoritative observer.
 *
 * Unlike a model/projection failure before any visible bytes, this is not a
 * condition the message boundary may translate into a synthetic assistant
 * reply: doing so would claim delivery after the client sink explicitly
 * rejected it. Callers must propagate this error (and its original cause)
 * without retrying or persisting a replacement response.
 */
export class CommittedReplyDeliveryError extends CommittedReplyProtocolError {
	constructor(message: string, cause?: unknown) {
		super(message, cause);
		this.name = "CommittedReplyDeliveryError";
	}
}

export interface CommittedReplyValidationContext {
	/** True only for the authoritative terminal candidate. */
	terminal: boolean;
}

export interface CommittedReplyStreamOptions {
	/**
	 * Receives only irrevocable, user-visible prefix extensions. The callback is
	 * awaited so provider pulls cannot overtake delivery ordering.
	 */
	onCommit: (chunk: string, accumulated: string) => void | Promise<void>;
	/**
	 * Optional prefix-monotone policy (for example, effect-claim grounding).
	 * Every early prefix and the terminal candidate must be independently safe.
	 */
	validateCandidate?: (
		candidate: string,
		context: CommittedReplyValidationContext,
	) => boolean | Promise<boolean>;
	/** Preserve a terminal, non-control JSON value without prose tag cleanup. */
	preserveJsonBytes?: boolean;
}

export interface CommittedReplyFinishResult {
	text: string;
	state: Exclude<CommittedReplyStreamState, "open" | "failed">;
	committedText: string;
	blockReason?: CommittedReplyBlockReason;
}

type CodeSpan = { start: number; end: number };

const COMPLETE_FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const COMPLETE_INLINE_CODE_RE = /(`+)[^`\n]+?\1(?!`)/g;
const SENTENCE_BOUNDARY_RE = /[.!?…](?:["'’”)\]]*)(?=\s|$)/gu;
const PARAGRAPH_BOUNDARY_RE = /\n[\t ]*\n/g;
const INTERNAL_BLOCK_TAGS = [
	"think",
	"thinking",
	"reasoning",
	"reflection",
	"thought",
	"analysis",
	"scratchpad",
	"antthinking",
	"tool_call",
	"tool_calls",
	"tool",
	"tools",
	"function_call",
] as const;
const INTERNAL_TAG_NAMES = [...INTERNAL_BLOCK_TAGS, "final"] as const;
const INTERNAL_ARTIFACTS = [
	"<stop>",
	"<stop/>",
	"<end>",
	"<end/>",
	"<end_turn>",
	"<end_turn/>",
	"<eot_id>",
	"<eot_id/>",
	"<|end|>",
	"<|stop|>",
	"<|im_end|>",
	"<|eot_id|>",
	"<|python_tag|>",
] as const;
const HARMONY_CONTROL_SENTINELS = [
	"<|start|>",
	"<|channel|>",
	"<|message|>",
] as const;

function spansOverlap(a: CodeSpan, b: CodeSpan): boolean {
	return a.start < b.end && b.start < a.end;
}

/** Complete Markdown code is display text, never internal model syntax. */
function collectCompleteCodeSpans(text: string): CodeSpan[] {
	const spans: CodeSpan[] = [];
	for (const match of text.matchAll(COMPLETE_FENCE_RE)) {
		const start = match.index ?? 0;
		spans.push({ start, end: start + match[0].length });
	}
	for (const match of text.matchAll(COMPLETE_INLINE_CODE_RE)) {
		const start = match.index ?? 0;
		const span = { start, end: start + match[0].length };
		if (!spans.some((candidate) => spansOverlap(candidate, span))) {
			spans.push(span);
		}
	}
	return spans.sort((a, b) => a.start - b.start);
}

function indexInsideSpans(index: number, spans: readonly CodeSpan[]): boolean {
	return spans.some((span) => index >= span.start && index < span.end);
}

/**
 * An unfinished code delimiter is ambiguous: internal-looking tags inside it
 * may become legitimate literal code once the closing delimiter arrives. Hold
 * everything from that delimiter rather than committing a lossy prefix.
 */
function findUnclosedCodeStart(
	text: string,
	completeSpans: readonly CodeSpan[],
): number | undefined {
	for (let index = 0; index < text.length; index++) {
		if (indexInsideSpans(index, completeSpans)) continue;
		if (text.startsWith("```", index) || text.startsWith("~~~", index)) {
			return index;
		}
		if (text[index] === "`") return index;
	}
	return undefined;
}

function replaceCodeSpans(
	text: string,
	spans: readonly CodeSpan[],
): { protectedText: string; values: string[] } {
	const values: string[] = [];
	let cursor = 0;
	let protectedText = "";
	for (const span of spans) {
		if (span.start < cursor) continue;
		protectedText += text.slice(cursor, span.start);
		const token = `\u0000CRS_CODE_${values.length}\u0000`;
		values.push(text.slice(span.start, span.end));
		protectedText += token;
		cursor = span.end;
	}
	protectedText += text.slice(cursor);
	return { protectedText, values };
}

function restoreCodeSpans(text: string, values: readonly string[]): string {
	let restored = text;
	for (let index = 0; index < values.length; index++) {
		restored = restored.replace(
			`\u0000CRS_CODE_${index}\u0000`,
			() => values[index],
		);
	}
	return restored;
}

function isTagBoundary(value: string | undefined): boolean {
	return value === undefined || /[\s/>]/u.test(value);
}

/**
 * Find syntax that may still resolve into an internal tag. This deliberately
 * recognizes partial tag names and unterminated attribute lists: a sentence
 * boundary inside `<tool_call name="x. y` is machine syntax, not display text.
 * Arbitrary HTML/XML remains untouched unless its name is one of the runtime's
 * reserved machine tags.
 */
function findUnresolvedInternalSyntaxStart(
	text: string,
	codeSpans: readonly CodeSpan[],
): number | undefined {
	for (let index = 0; index < text.length; index++) {
		if (text[index] !== "<" || indexInsideSpans(index, codeSpans)) continue;
		const tail = text.slice(index);
		const lowerTail = tail.toLowerCase();
		for (const sentinel of HARMONY_CONTROL_SENTINELS) {
			if (sentinel.startsWith(lowerTail) || lowerTail.startsWith(sentinel)) {
				return index;
			}
		}

		for (const artifact of INTERNAL_ARTIFACTS) {
			if (artifact.startsWith(lowerTail) && lowerTail !== artifact)
				return index;
		}

		const prefixMatch = /^<\/?([a-z_|]*)/i.exec(tail);
		const fragment = prefixMatch?.[1]?.toLowerCase() ?? "";
		if (!fragment) continue;
		const candidate = INTERNAL_TAG_NAMES.find((name) =>
			name.startsWith(fragment),
		);
		if (!candidate) continue;
		if (fragment.length < candidate.length) return index;

		const nameEnd = (prefixMatch?.[0].length ?? 1) + index;
		if (!isTagBoundary(text[nameEnd])) continue;
		const openerEnd = text.indexOf(">", nameEnd);
		if (openerEnd < 0) return index;
		if (!tail.startsWith("</") && candidate === "final") {
			const closing = new RegExp(`</${candidate}\\s*>`, "i");
			if (!closing.test(text.slice(openerEnd + 1))) return index;
		}
	}
	return undefined;
}

/** Strip internal syntax without trimming or normalizing any display bytes. */
function sanitizePrefixStable(text: string): string {
	let processed = text;
	processed = processed.replace(
		/<(?:STOP|END|end_turn|eot_id)\s*\/?>|<\|(?:end|stop|im_end|eot_id)\|>/gi,
		"",
	);
	processed = processed.replace(/<\|python_tag\|>[\s\S]*$/gi, "");
	for (const tag of INTERNAL_BLOCK_TAGS) {
		const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, "gi");
		processed = processed.replace(paired, "");
		const unclosed = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "gi");
		processed = processed.replace(unclosed, "");
		const orphanClosing = new RegExp(`</${tag}\\s*>`, "gi");
		processed = processed.replace(orphanClosing, "");
	}
	processed = processed.replace(/<final\b[^>]*>([\s\S]*?)<\/final\s*>/gi, "$1");
	processed = processed.replace(/\/?\bno_think\b/gi, "");
	return processed;
}

function canonicalizeDisplayText(text: string): {
	text: string;
	safeCommitCeiling: number;
	unresolvedInternalControl: boolean;
} {
	const codeSpans = collectCompleteCodeSpans(text);
	const unclosedCodeStart = findUnclosedCodeStart(text, codeSpans);
	const unresolvedInternalStart = findUnresolvedInternalSyntaxStart(
		text,
		codeSpans,
	);
	const { protectedText, values } = replaceCodeSpans(text, codeSpans);
	const canonical = restoreCodeSpans(
		sanitizePrefixStable(protectedText),
		values,
	);
	const holdStart = [unclosedCodeStart, unresolvedInternalStart]
		.filter((value): value is number => value !== undefined)
		.reduce<number | undefined>(
			(current, value) =>
				current === undefined ? value : Math.min(current, value),
			undefined,
		);
	if (holdStart === undefined) {
		return {
			text: canonical,
			safeCommitCeiling: canonical.length,
			unresolvedInternalControl: false,
		};
	}
	const safePrefix = canonicalizeDisplayText(text.slice(0, holdStart)).text;
	return {
		text: canonical,
		safeCommitCeiling: Math.min(safePrefix.length, canonical.length),
		unresolvedInternalControl: unresolvedInternalStart !== undefined,
	};
}

function textOutsideCode(text: string): string {
	const spans = collectCompleteCodeSpans(text);
	let cursor = 0;
	let output = "";
	for (const span of spans) {
		output += text.slice(cursor, span.start);
		output += " ".repeat(span.end - span.start);
		cursor = span.end;
	}
	return output + text.slice(cursor);
}

function isPotentialJsonValue(text: string, includeScalars: boolean): boolean {
	const first = text.trimStart()[0];
	if (first === "{" || first === "[") return true;
	return (
		includeScalars &&
		(first === '"' ||
			first === "-" ||
			(first !== undefined && /[0-9tfn]/iu.test(first)))
	);
}

const YAML_CONTROL_KEYS = [
	"shouldRespond",
	"processMessage",
	"replyText",
	"messageToUser",
	"thought",
	"reasoning",
	"analysis",
	"scratchpad",
	"contexts",
	"candidateActionNames",
	"requiresTool",
	"facts",
	"action",
	"actions",
	"parameters",
	"toolCalls",
	"tool_calls",
	"tool_call",
	"tool_use",
	"tool",
	"tools",
	"toolCallId",
	"function",
	"functionCall",
	"function_call",
	"decision",
	"route",
] as const;

const HIGH_CONFIDENCE_YAML_CONTROL_KEYS = new Set([
	"shouldrespond",
	"processmessage",
	"replytext",
	"messagetouser",
	"thought",
	"reasoning",
	"analysis",
	"scratchpad",
	"candidateactionnames",
	"requirestool",
	"toolcalls",
	"tool_calls",
	"tool_call",
	"tool_use",
	"tool",
	"tools",
	"toolcallid",
	"functioncall",
	"function_call",
]);
const YAML_CONTROL_DISCRIMINATORS = [
	"tool_use",
	"tool_call",
	"function_call",
] as const;

function parseJsonValue(text: string): unknown | undefined {
	const inspectable = text.trim();
	if (!inspectable) return undefined;
	try {
		return JSON.parse(inspectable) as unknown;
	} catch {
		return undefined;
	}
}

interface YamlPayloadLine {
	indent: number;
	text: string;
}

function stripYamlPresentationPrefix(line: string): string {
	let candidate = line.trim();
	while (candidate.startsWith(">")) {
		candidate = candidate.slice(1).trimStart();
	}
	candidate = candidate.replace(/^(?:[-*+]|\d+[.)])\s+/u, "");
	return candidate.trimStart();
}

function yamlIndentWidth(line: string): number {
	let width = 0;
	for (const character of line) {
		if (character === " ") width += 1;
		else if (character === "\t") width += 2;
		else break;
	}
	return width;
}

function yamlPayloadLines(text: string): {
	lines: YamlPayloadLine[];
	waitingForPayload: boolean;
} {
	const inspectable = textOutsideCode(text);
	const payloadLines: YamlPayloadLine[] = [];
	let sawPreamble = false;
	for (const rawLine of inspectable.split(/\r?\n/)) {
		const line = stripYamlPresentationPrefix(rawLine);
		if (!line || line === "---" || line === "..." || line.startsWith("#")) {
			if (line) sawPreamble = true;
			continue;
		}
		payloadLines.push({
			indent: yamlIndentWidth(rawLine),
			text: rawLine.trim(),
		});
	}
	return {
		lines: payloadLines,
		waitingForPayload: payloadLines.length === 0 && sawPreamble,
	};
}

const YAML_CONTROL_KEY_SET = new Set(
	YAML_CONTROL_KEYS.map((key) => key.toLowerCase()),
);

function yamlRootField(
	line: string,
): { key: string; value: string } | undefined {
	const candidate = stripYamlPresentationPrefix(line).replace(/^[{[(]\s*/u, "");
	const match =
		/^(?:(["'])([a-z_][a-z0-9_-]*)\1|([a-z_][a-z0-9_-]*))\s*[:=]\s*(.*)$/iu.exec(
			candidate,
		);
	const key = match?.[2] ?? match?.[3];
	return key
		? { key: key.toLowerCase(), value: match?.[4]?.trim() ?? "" }
		: undefined;
}

function yamlStructuralFields(text: string): Array<{
	indent: number;
	key: string;
	value: string;
}> {
	return yamlPayloadLines(text).lines.flatMap((line) => {
		const field = yamlRootField(line.text);
		return field ? [{ ...field, indent: line.indent }] : [];
	});
}

function normalizeYamlScalar(value: string): string {
	const trimmed = value.trim();
	if (
		trimmed.length >= 2 &&
		((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
			(trimmed.startsWith("'") && trimmed.endsWith("'")))
	) {
		return trimmed.slice(1, -1).trim().toLowerCase();
	}
	return trimmed.toLowerCase();
}

function yamlFieldsContainControl(
	fields: readonly { indent: number; key: string; value: string }[],
): boolean {
	if (
		fields.some((field) => HIGH_CONFIDENCE_YAML_CONTROL_KEYS.has(field.key))
	) {
		return true;
	}
	if (
		fields.some(
			(field) =>
				field.key === "type" &&
				YAML_CONTROL_DISCRIMINATORS.includes(
					normalizeYamlScalar(
						field.value,
					) as (typeof YAML_CONTROL_DISCRIMINATORS)[number],
				),
		)
	) {
		return true;
	}
	if (
		fields.some((field) => {
			if (field.key !== "action" && field.key !== "function") return false;
			return /^[a-z_][a-z0-9_.:-]*$/iu.test(normalizeYamlScalar(field.value));
		})
	) {
		return true;
	}
	// Low-specificity words such as `action`, `thought`, or `route` may be
	// ordinary prose labels on their own. Two structural control keys at the
	// same mapping depth form a runtime-shaped record and avoid blocking a
	// standalone `Action: ...` line. Checking every depth also catches a wrapper
	// such as `plan:\n  action: ...\n  parameters: ...`.
	const reservedKeysByIndent = new Map<number, Set<string>>();
	for (const field of fields) {
		if (!YAML_CONTROL_KEY_SET.has(field.key)) continue;
		const keys = reservedKeysByIndent.get(field.indent) ?? new Set<string>();
		keys.add(field.key);
		reservedKeysByIndent.set(field.indent, keys);
	}
	return [...reservedKeysByIndent.values()].some((keys) => keys.size >= 2);
}

function containsYamlControlEnvelope(text: string): boolean {
	return yamlFieldsContainControl(yamlStructuralFields(text));
}

/** Hold any split root YAML key until it resolves to prose or control syntax. */
function isPotentialYamlControlEnvelope(text: string): boolean {
	const candidate = yamlPayloadLines(text);
	if (candidate.waitingForPayload) return true;
	const fields = yamlStructuralFields(text);
	if (yamlFieldsContainControl(fields)) return true;
	const trailingLine = stripYamlPresentationPrefix(
		candidate.lines.at(-1)?.text ?? "",
	)
		.replace(/^[{[(]\s*/u, "")
		.replace(/^["']/u, "");
	const trailingField = yamlRootField(trailingLine);
	if (trailingField?.key === "type") {
		const discriminator = normalizeYamlScalar(trailingField.value);
		if (
			discriminator.length > 0 &&
			YAML_CONTROL_DISCRIMINATORS.some((value) =>
				value.startsWith(discriminator),
			)
		) {
			return true;
		}
	}
	if (!/^[a-z_][a-z0-9_-]*$/iu.test(trailingLine)) return false;
	const lower = trailingLine.toLowerCase();
	return YAML_CONTROL_KEYS.some((key) => key.toLowerCase().startsWith(lower));
}

function containsInternalControlEnvelope(text: string): boolean {
	const inspectable = textOutsideCode(text).trim();
	if (!inspectable) return false;
	const parsed = parseJsonValue(inspectable);
	if (parsed !== undefined) return !isSafeUserVisibleJsonText(inspectable);
	if (classifyCompactUserVisibleControlDialect(inspectable)) return true;
	if (containsYamlControlEnvelope(text)) return true;
	return HARMONY_CONTROL_SENTINELS.some((sentinel) =>
		inspectable.toLowerCase().includes(sentinel),
	);
}

function stableBoundaries(
	text: string,
	start: number,
	ceiling: number,
): number[] {
	const boundaries = new Set<number>();
	SENTENCE_BOUNDARY_RE.lastIndex = start;
	for (
		let match = SENTENCE_BOUNDARY_RE.exec(text);
		match;
		match = SENTENCE_BOUNDARY_RE.exec(text)
	) {
		const end = match.index + match[0].length;
		if (end > ceiling) break;
		if (isAbbreviationPeriod(text, match.index)) continue;
		if (/\S/u.test(text.slice(end, ceiling))) {
			boundaries.add(end);
		}
	}
	PARAGRAPH_BOUNDARY_RE.lastIndex = start;
	for (
		let match = PARAGRAPH_BOUNDARY_RE.exec(text);
		match;
		match = PARAGRAPH_BOUNDARY_RE.exec(text)
	) {
		const end = match.index + match[0].length;
		if (end > ceiling) break;
		if (/\S/u.test(text.slice(end, ceiling))) boundaries.add(end);
	}
	return [...boundaries].sort((a, b) => a - b);
}

/**
 * Converts genuine provider deltas into irrevocable sentence/paragraph prefix
 * commitments. It never invents timing or text: a commit advances only after a
 * newly received provider chunk proves a complete, sanitized source prefix.
 */
export class CommittedReplyStream {
	private rawText = "";
	private committed = "";
	private streamState: CommittedReplyStreamState = "open";
	private reason: CommittedReplyBlockReason | undefined;
	private operationTail: Promise<void> = Promise.resolve();

	constructor(private readonly options: CommittedReplyStreamOptions) {}

	get state(): CommittedReplyStreamState {
		return this.streamState;
	}

	get committedText(): string {
		return this.committed;
	}

	pushProviderChunk(chunk: string): Promise<void> {
		return this.enqueue(async () => this.pushProviderChunkSerial(chunk));
	}

	private async pushProviderChunkSerial(chunk: string): Promise<void> {
		if (
			!chunk ||
			this.streamState === "aborted" ||
			this.streamState === "blocked"
		) {
			return;
		}
		if (this.streamState !== "open") {
			throw new CommittedReplyProtocolError(
				`Cannot push a provider chunk after stream state ${this.streamState}`,
			);
		}
		if (this.rawText.length + chunk.length > MAX_COMMITTED_REPLY_SOURCE_CHARS) {
			this.fail("Committed reply source exceeded its bounded size");
		}
		this.rawText += chunk;
		await this.commitAvailable(false);
	}

	abort(): void {
		if (this.streamState === "open") this.streamState = "aborted";
	}

	finish(authoritativeText?: string): Promise<CommittedReplyFinishResult> {
		return this.enqueue(async () =>
			this.finishSerial(authoritativeText ?? this.rawText),
		);
	}

	private async finishSerial(
		authoritativeText: string,
	): Promise<CommittedReplyFinishResult> {
		if (this.streamState === "failed" || this.streamState === "complete") {
			throw new CommittedReplyProtocolError(
				`Cannot finish a committed reply in state ${this.streamState}`,
			);
		}
		if (this.streamState === "aborted" || this.streamState === "blocked") {
			return this.finishResult();
		}
		if (authoritativeText.length > MAX_COMMITTED_REPLY_SOURCE_CHARS) {
			this.fail("Authoritative reply exceeded its bounded size");
		}
		this.rawText = authoritativeText;
		await this.commitAvailable(true);
		if (this.streamState === "open") this.streamState = "complete";
		return this.finishResult();
	}

	private async commitAvailable(terminal: boolean): Promise<void> {
		if (containsExternalEnvelopeMaterial(this.rawText)) {
			this.block("external_envelope");
			return;
		}
		const parsedJson = this.options.preserveJsonBytes
			? parseJsonValue(this.rawText)
			: undefined;
		const canonical =
			parsedJson !== undefined
				? {
						text: this.rawText,
						safeCommitCeiling: this.rawText.length,
						unresolvedInternalControl: false,
					}
				: canonicalizeDisplayText(this.rawText);
		if (!canonical.text.startsWith(this.committed)) {
			this.fail(
				"Authoritative display text diverged from a committed prefix",
				undefined,
				true,
			);
		}
		if (
			terminal &&
			(canonical.unresolvedInternalControl ||
				containsInternalControlEnvelope(canonical.text))
		) {
			this.block("internal_control");
			return;
		}
		// Unfenced top-level JSON may be legitimate user-requested JSON. Preserve
		// it, but hold it until terminal validation can distinguish it from the
		// runtime's own response-handler envelope.
		const holdStructuredCandidate =
			!terminal &&
			(isPotentialJsonValue(
				this.rawText,
				this.options.preserveJsonBytes === true,
			) ||
				isPotentialYamlControlEnvelope(this.rawText));
		const ends = holdStructuredCandidate
			? []
			: terminal
				? [canonical.text.length]
				: stableBoundaries(
						canonical.text,
						this.committed.length,
						canonical.safeCommitCeiling,
					);
		for (const end of ends) {
			if (end <= this.committed.length) continue;
			if (this.streamState !== "open") return;
			const accumulated = canonical.text.slice(0, end);
			if (this.options.validateCandidate) {
				let accepted: boolean;
				try {
					accepted = await this.options.validateCandidate(accumulated, {
						terminal,
					});
				} catch (cause) {
					if (this.streamState !== "open") return;
					this.fail(
						"Committed reply validator threw",
						cause,
						this.committed.length > 0,
					);
				}
				if (this.streamState !== "open") return;
				if (!accepted) {
					this.fail(
						"Committed reply validator rejected a candidate",
						undefined,
						this.committed.length > 0,
					);
				}
			}
			if (this.streamState !== "open") return;
			const delta = accumulated.slice(this.committed.length);
			try {
				await this.options.onCommit(delta, accumulated);
			} catch (cause) {
				// An owner abort can land after the pre-delivery state check but
				// before (or during) the awaited observer. Preserve its exact typed
				// reason; it is not a downstream sink rejection.
				if (this.wasAborted()) throw cause;
				this.streamState = "failed";
				throw new CommittedReplyDeliveryError(
					"Committed reply delivery rejected a candidate",
					cause,
				);
			}
			// The callback is the side-effect boundary. If cancellation arrived
			// while it was in flight but the callback fulfilled, these bytes did
			// cross the observer and must remain part of the frozen prefix.
			this.committed = accumulated;
			if (this.streamState !== "open") return;
		}
	}

	private wasAborted(): boolean {
		return this.streamState === "aborted";
	}

	private block(reason: CommittedReplyBlockReason): void {
		this.reason = reason;
		this.streamState = "blocked";
	}

	private fail(
		message: string,
		cause?: unknown,
		recoverableCommittedPrefix = this.committed.length > 0,
	): never {
		this.streamState = "failed";
		throw new CommittedReplyProtocolError(message, cause, {
			recoverableCommittedPrefix,
		});
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationTail.then(operation, operation);
		this.operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private finishResult(): CommittedReplyFinishResult {
		const state = this.streamState as Exclude<
			CommittedReplyStreamState,
			"open" | "failed"
		>;
		return {
			text: this.committed,
			state,
			committedText: this.committed,
			...(this.reason ? { blockReason: this.reason } : {}),
		};
	}
}
