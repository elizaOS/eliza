/**
 * Streaming utilities for filtering and extracting streamable content.
 *
 * This module provides implementations of {@link IStreamExtractor}:
 * - PassthroughExtractor - Simple passthrough (no filtering)
 * - StructuredFieldStreamExtractor - Extract top-level structured fields safely
 *
 * For the interface definition, see types/streaming.ts.
 * Implementations can use these or create their own extractors.
 */

import type { StreamChunkCallback } from "../types/components";
import type {
	IStreamExtractor,
	StructuredFieldEventCallbacks,
} from "../types/streaming";

// ============================================================================
// StreamError - Standardized error handling for streaming
// ============================================================================

/** Error codes for streaming operations */
export type StreamErrorCode =
	| "CHUNK_TOO_LARGE"
	| "BUFFER_OVERFLOW"
	| "PARSE_ERROR"
	| "TIMEOUT"
	| "ABORTED";

/**
 * Standardized error class for streaming operations.
 * Provides structured error codes for easier handling.
 */
export class StreamError extends Error {
	readonly code: StreamErrorCode;
	readonly details?: Record<string, unknown>;

	constructor(
		code: StreamErrorCode,
		message: string,
		details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "StreamError";
		this.code = code;
		this.details = details;
	}

	/** Check if an error is a StreamError */
	static isStreamError(error: unknown): error is StreamError {
		return error instanceof StreamError;
	}
}

// ============================================================================
// Shared constants and utilities
// ============================================================================

/** Maximum chunk size to prevent DoS (1MB) */
const MAX_CHUNK_SIZE = 1024 * 1024;

/**
 * Validates and limits chunk size to prevent DoS attacks.
 * @throws StreamError if chunk exceeds maximum size
 */
function validateChunkSize(chunk: string): void {
	if (chunk.length > MAX_CHUNK_SIZE) {
		throw new StreamError(
			"CHUNK_TOO_LARGE",
			`Chunk size ${chunk.length} exceeds maximum allowed ${MAX_CHUNK_SIZE}`,
			{
				chunkSize: chunk.length,
				maxAllowed: MAX_CHUNK_SIZE,
			},
		);
	}
}

// ============================================================================
// PassthroughExtractor - Simplest implementation
// ============================================================================

/**
 * Streams all content as-is without any filtering.
 * Use when LLM output is already in the desired format (e.g., plain text responses).
 */
export class PassthroughExtractor implements IStreamExtractor {
	get done(): boolean {
		return false; // Never "done" - always accepts more
	}

	push(chunk: string): string {
		validateChunkSize(chunk);
		return chunk; // Pass through everything
	}

	reset(): void {
		// Nothing to reset
	}
}

// ============================================================================
// MarkableExtractor - Passthrough with external completion control
// ============================================================================

/**
 * Passthrough extractor that can be marked complete externally.
 *
 * WHY: When using StructuredFieldStreamExtractor inside dynamicPromptExecFromState,
 * extraction/completion is handled internally. But the outer streaming context
 * still needs to know when streaming is complete for retry/fallback logic.
 *
 * This extractor passes through all content and provides a markComplete() method
 * that the caller can invoke when the underlying operation completes successfully.
 *
 * @example
 * ```ts
 * const extractor = new MarkableExtractor();
 * const ctx = createStreamingContext(extractor, callback);
 *
 * const result = await dynamicPromptExecFromState({ ... });
 * if (result) {
 *   extractor.markComplete(); // Signal success
 * }
 *
 * if (ctx.isComplete()) {
 *   // Now returns true after markComplete()
 * }
 * ```
 */
export class MarkableExtractor implements IStreamExtractor {
	private _done = false;

	get done(): boolean {
		return this._done;
	}

	push(chunk: string): string {
		validateChunkSize(chunk);
		return chunk; // Pass through everything
	}

	flush(): string {
		return "";
	}

	reset(): void {
		this._done = false;
	}

	/**
	 * Mark the extractor as complete.
	 * WHY: Called by the outer code when the underlying operation completes
	 * successfully. This allows isComplete() to return true for retry/fallback logic.
	 */
	markComplete(): void {
		this._done = true;
	}
}

import type { SchemaRow, StreamEvent } from "../types/state";
import type { IStreamingRetryState } from "../types/streaming";

/**
 * Extractor state machine for validation-aware streaming.
 */
export type ExtractorState =
	| "streaming" // Normal operation - actively receiving chunks
	| "validating" // Stream ended, checking validation codes
	| "retrying" // Validation failed, preparing for retry
	| "complete" // Successfully finished
	| "failed"; // Unrecoverable error

/**
 * Per-field state tracking for progressive validation.
 */
export type FieldState =
	| "pending" // Haven't seen this field yet
	| "partial" // Found a field start but not the next top-level boundary
	| "complete" // Field content extracted
	| "invalid"; // Validation codes didn't match

/**
 * Configuration for StructuredFieldStreamExtractor.
 */
export interface StructuredFieldStreamExtractorConfig
	extends StructuredFieldEventCallbacks {
	/** Validation level (0-3). Level 2+ buffers until flush. */
	level: 0 | 1 | 2 | 3;
	/** Schema rows with field definitions */
	schema: SchemaRow[];
	/** Which top-level structured fields to stream to the consumer */
	streamFields: string[];
	/**
	 * Callback for streaming chunks.
	 * WHY accumulated: consumers (voice detection, client-side merge) need the
	 * full field text to avoid re-deriving it from deltas.
	 */
	onChunk: (chunk: string, field?: string, accumulated?: string) => void;
	/** Rich event callback for sophisticated consumers */
	onEvent?: (event: StreamEvent) => void;
	/** Abort signal for cancellation */
	abortSignal?: AbortSignal;
}

/**
 * Diagnosis result for error analysis.
 */
export interface ValidationDiagnosis {
	/** Fields that were never started */
	missingFields: string[];
	/** Fields with wrong validation codes */
	invalidFields: string[];
	/** Fields that started but didn't complete */
	incompleteFields: string[];
}

// ============================================================================
// StructuredFieldStreamExtractor - top-level field extraction
// ============================================================================

const STRUCTURED_TOP_LEVEL_FIELD_RE =
	/^([A-Za-z_][A-Za-z0-9_.-]*(?:\[[^\]\n]*\])?(?:\{[^\n]*\})?):(?:\s?(.*))?$/;

/**
 * Extracts configured top-level scalar fields from line-oriented text without streaming
 * surrounding control fields such as thought/actions/providers.
 *
 * This intentionally avoids decoding partial structured documents. It processes
 * complete lines, tracks top-level field boundaries, and only emits values for
 * fields explicitly listed in `streamFields`.
 */
export class StructuredFieldStreamExtractor implements IStreamExtractor {
	private lineBuffer = "";
	private currentField: string | null = null;
	private fieldContents: Map<string, string> = new Map();
	private emittedContent: Map<string, string> = new Map();
	private validatedFields: Set<string> = new Set();
	private fieldStates: Map<string, FieldState> = new Map();
	private state: ExtractorState = "streaming";
	private readonly streamFieldSet: Set<string>;
	/**
	 * The top-level field whose value bytes are currently arriving — tracked for
	 * ALL fields (not just streamed ones) so per-field start/done events have a
	 * correct decoded value. `currentField` (above) is the narrower "currently
	 * streamed to onChunk" pointer.
	 */
	private currentTrackedField: string | null = null;
	/** Fields for which `onFieldStart` has already fired (dedupe). */
	private startedFields: Set<string> = new Set();
	/** Fields for which `onFieldDone` has already fired (dedupe). */
	private doneFields: Set<string> = new Set();

	constructor(private readonly config: StructuredFieldStreamExtractorConfig) {
		this.streamFieldSet = new Set(config.streamFields);
		for (const row of config.schema) {
			this.fieldStates.set(row.field, "pending");
		}
	}

	get done(): boolean {
		return this.state === "complete" || this.state === "failed";
	}

	push(chunk: string): string {
		if (this.config.abortSignal?.aborted) {
			if (this.state !== "complete" && this.state !== "failed") {
				this.state = "failed";
				this.emitEvent({
					eventType: "error",
					error: "Cancelled by user",
					timestamp: Date.now(),
				});
			}
			return "";
		}

		if (this.state !== "streaming") return "";

		validateChunkSize(chunk);
		this.lineBuffer += chunk;
		this.processAvailableLines(false);
		return "";
	}

	flush(): string {
		if (this.state === "failed") {
			return "";
		}

		this.processAvailableLines(true);
		this.completeCurrentField();

		if (this.config.level >= 2) {
			for (const field of this.config.streamFields) {
				const content = this.fieldContents.get(field) || "";
				if (content) {
					this.emitFieldContent(field, content);
				}
			}
		}

		this.closeCurrentTrackedField();
		this.state = "complete";
		this.emitEvent({ eventType: "complete", timestamp: Date.now() });
		return "";
	}

	reset(): void {
		this.lineBuffer = "";
		this.currentField = null;
		this.currentTrackedField = null;
		this.startedFields.clear();
		this.doneFields.clear();
		this.fieldContents.clear();
		this.emittedContent.clear();
		this.validatedFields.clear();
		for (const row of this.config.schema) {
			this.fieldStates.set(row.field, "pending");
		}
		this.state = "streaming";
	}

	signalRetry(retryCount: number): { validatedFields: string[] } {
		this.state = "retrying";
		this.emitEvent({
			eventType: "retry_start",
			retryCount,
			timestamp: Date.now(),
		});
		return { validatedFields: Array.from(this.validatedFields) };
	}

	signalError(message: string): void {
		this.state = "failed";
		this.emitEvent({
			eventType: "error",
			error: message,
			timestamp: Date.now(),
		});
	}

	getValidatedFields(): Map<string, string> {
		const result = new Map<string, string>();
		for (const field of this.validatedFields) {
			const content = this.fieldContents.get(field);
			if (content) {
				result.set(field, content);
			}
		}
		return result;
	}

	diagnose(): ValidationDiagnosis {
		const missingFields: string[] = [];
		const invalidFields: string[] = [];
		const incompleteFields: string[] = [];

		for (const row of this.config.schema) {
			const state = this.fieldStates.get(row.field);
			switch (state) {
				case "pending":
					missingFields.push(row.field);
					break;
				case "invalid":
					invalidFields.push(row.field);
					break;
				case "partial":
					incompleteFields.push(row.field);
					break;
			}
		}

		return { missingFields, invalidFields, incompleteFields };
	}

	getState(): ExtractorState {
		return this.state;
	}

	private processAvailableLines(final: boolean): void {
		let newlineIndex = this.lineBuffer.search(/\r?\n/);
		while (newlineIndex !== -1) {
			const newlineLength =
				this.lineBuffer[newlineIndex] === "\r" &&
				this.lineBuffer[newlineIndex + 1] === "\n"
					? 2
					: 1;
			const line = this.lineBuffer.slice(0, newlineIndex);
			this.lineBuffer = this.lineBuffer.slice(newlineIndex + newlineLength);
			this.processLine(line);
			newlineIndex = this.lineBuffer.search(/\r?\n/);
		}

		if (final && this.lineBuffer.length > 0) {
			this.processLine(this.lineBuffer);
			this.lineBuffer = "";
		}
	}

	private processLine(line: string): void {
		const isTopLevel = !/^[\t ]/.test(line);
		const fieldMatch = isTopLevel
			? line.match(STRUCTURED_TOP_LEVEL_FIELD_RE)
			: null;

		if (fieldMatch) {
			this.completeCurrentField();
			this.closeCurrentTrackedField();
			const rawKey = fieldMatch[1] ?? "";
			const field = this.baseStructuredFieldName(rawKey);
			const rawValue = fieldMatch[2] ?? "";
			this.fieldStates.set(field, "partial");
			this.emitFieldStart(field);
			this.currentTrackedField = field;

			if (!this.streamFieldSet.has(field)) {
				this.currentField = null;
				if (rawValue.trim().length > 0) {
					this.appendFieldContent(field, this.parseInlineValue(rawValue));
					this.fieldStates.set(field, "complete");
					this.closeCurrentTrackedField();
				}
				return;
			}

			this.currentField = field;
			if (rawValue.trim().length > 0) {
				this.appendFieldContent(field, this.parseInlineValue(rawValue));
				this.completeCurrentField();
				this.closeCurrentTrackedField();
			}
			return;
		}

		if (this.currentTrackedField) {
			this.appendFieldContent(
				this.currentTrackedField,
				this.normalizeContinuationLine(line),
			);
			if (this.currentField && this.streamFieldSet.has(this.currentField)) {
				// emitFieldContent diffing happens on completeCurrentField for
				// level <= 1; nothing additional needed per continuation line.
			}
		}
	}

	private completeCurrentField(): void {
		if (!this.currentField) {
			return;
		}

		const field = this.currentField;
		this.fieldStates.set(field, "complete");
		this.validatedFields.add(field);
		if (this.config.level <= 1) {
			const content = this.fieldContents.get(field) || "";
			if (content) {
				this.emitFieldContent(field, content);
			}
		}
		this.currentField = null;
	}

	private emitFieldStart(field: string): void {
		if (this.startedFields.has(field)) {
			return;
		}
		this.startedFields.add(field);
		this.config.onFieldStart?.(field);
	}

	private closeCurrentTrackedField(): void {
		const field = this.currentTrackedField;
		this.currentTrackedField = null;
		if (!field || this.doneFields.has(field)) {
			return;
		}
		this.doneFields.add(field);
		this.config.onFieldDone?.(field, this.fieldContents.get(field) ?? "");
	}

	private appendFieldContent(field: string, value: string): void {
		const previous = this.fieldContents.get(field);
		if (previous === undefined || previous.length === 0) {
			this.fieldContents.set(field, value);
			return;
		}
		this.fieldContents.set(field, `${previous}\n${value}`);
	}

	private parseInlineValue(rawValue: string): string {
		const value = rawValue.trim();
		if (value.length === 0) {
			return "";
		}

		if (value.startsWith('"') && value.endsWith('"')) {
			try {
				return JSON.parse(value) as string;
			} catch {
				return value.slice(1, -1);
			}
		}

		if (value.startsWith("'") && value.endsWith("'")) {
			return value.slice(1, -1);
		}

		return value;
	}

	private normalizeContinuationLine(line: string): string {
		if (line.startsWith("  ")) {
			return line.slice(2);
		}
		if (line.startsWith("\t")) {
			return line.slice(1);
		}
		return line;
	}

	private baseStructuredFieldName(rawKey: string): string {
		return rawKey.split(/[[{]/, 1)[0] ?? rawKey;
	}

	private emitFieldContent(field: string, content: string): void {
		const previouslyEmitted = this.emittedContent.get(field) || "";

		if (content.length < previouslyEmitted.length) {
			this.emittedContent.set(field, content);
			if (content) {
				this.config.onChunk(content, field, content);
				this.emitEvent({
					eventType: "chunk",
					field,
					chunk: content,
					timestamp: Date.now(),
				});
			}
			return;
		}

		const newContent = content.substring(previouslyEmitted.length);
		if (newContent) {
			this.config.onChunk(newContent, field, content);
			this.emitEvent({
				eventType: "chunk",
				field,
				chunk: newContent,
				timestamp: Date.now(),
			});
			this.emittedContent.set(field, content);
		}
	}

	private emitEvent(event: StreamEvent): void {
		if (this.config.onEvent) {
			this.config.onEvent(event);
		}
	}
}

// ============================================================================
// Streaming Context Helpers
// ============================================================================

import type { StreamingContext } from "../streaming-context";

/**
 * Creates a streaming retry state from an extractor.
 */
export function createStreamingRetryState(
	extractor: IStreamExtractor,
): IStreamingRetryState & { appendText: (text: string) => void } {
	let streamedText = "";

	return {
		getStreamedText: () => {
			const buffered = extractor.flush?.() ?? "";
			if (buffered) {
				streamedText += buffered;
			}
			return streamedText;
		},
		isComplete: () => extractor.done,
		reset: () => {
			extractor.reset?.();
			streamedText = "";
		},
		/** Append text to the streamed content buffer */
		appendText: (text: string) => {
			streamedText += text;
		},
	};
}

/**
 * Creates a complete streaming context with retry state management.
 */
export function createStreamingContext(
	extractor: IStreamExtractor,
	onStreamChunk: StreamChunkCallback,
	messageId?: string,
): StreamingContext & IStreamingRetryState {
	const retryState = createStreamingRetryState(extractor);

	return {
		/**
		 * NOTE: `accumulated` from the upstream source is forwarded unchanged.
		 * This is only semantically correct when `extractor` is a passthrough
		 * (i.e., extractor.push(chunk) === chunk). MarkableExtractor satisfies
		 * this invariant; other extractors may not.
		 */
		onStreamChunk: async (
			chunk: string,
			msgId?: string,
			accumulated?: string,
		) => {
			if (extractor.done) return;
			const textToStream = extractor.push(chunk);
			if (textToStream) {
				retryState.appendText(textToStream);
				await onStreamChunk(textToStream, msgId, accumulated);
			}
		},
		messageId,
		reset: retryState.reset,
		getStreamedText: retryState.getStreamedText,
		isComplete: retryState.isComplete,
	};
}
