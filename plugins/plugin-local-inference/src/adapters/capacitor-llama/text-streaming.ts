/**
 * Capacitor → `TextStreamResult` bridge.
 *
 * The Capacitor `LlamaContext.completion(params, callback)` API is push-based:
 * `callback` fires once per token. The elizaOS runtime consumes a pull-based
 * `TextStreamResult` (`{ textStream, text, usage, finishReason }`). We bridge
 * the two with a queue-backed async iterator.
 */

import type { TextStreamResult, TokenUsage } from "@elizaos/core";
import type {
	CapacitorLlamaCompletionParams,
	CapacitorLlamaCompletionResult,
	CapacitorLlamaContext,
} from "./types";

function indexOfIgnoreCase(haystack: string, needle: string): number {
	return haystack.toLowerCase().indexOf(needle.toLowerCase());
}

function createThinkTagStreamFilter(): {
	push(chunk: string): string[];
	flush(): string[];
} {
	let buffer = "";
	let inThink = false;
	const openMarker = "<think";
	const closeMarker = "</think>";
	const safeOpenTail = openMarker.length - 1;
	const safeCloseTail = closeMarker.length - 1;

	const drain = (final: boolean): string[] => {
		const out: string[] = [];
		for (;;) {
			if (inThink) {
				const closeAt = indexOfIgnoreCase(buffer, closeMarker);
				if (closeAt === -1) {
					buffer = final ? "" : buffer.slice(-safeCloseTail);
					return out;
				}
				buffer = buffer.slice(closeAt + closeMarker.length);
				inThink = false;
				continue;
			}

			const openAt = indexOfIgnoreCase(buffer, openMarker);
			if (openAt === -1) {
				const emitLength = final
					? buffer.length
					: Math.max(0, buffer.length - safeOpenTail);
				if (emitLength > 0) {
					out.push(buffer.slice(0, emitLength));
					buffer = buffer.slice(emitLength);
				}
				return out;
			}

			if (openAt > 0) {
				out.push(buffer.slice(0, openAt));
				buffer = buffer.slice(openAt);
			}

			const tagEnd = buffer.indexOf(">");
			if (tagEnd === -1) {
				if (final) {
					buffer = "";
					return out;
				}
				return out;
			}
			buffer = buffer.slice(tagEnd + 1);
			inThink = true;
		}
	};

	return {
		push(chunk: string): string[] {
			buffer += chunk;
			return drain(false);
		},
		flush(): string[] {
			return drain(true);
		},
	};
}

export interface StreamCapacitorPromptArgs {
	ctx: CapacitorLlamaContext;
	params: CapacitorLlamaCompletionParams;
	estimateUsage: (prompt: string, fullText: string) => TokenUsage;
	onChunk?: (delta: string) => void;
	onComplete?: (info: { fullText: string; usage: TokenUsage }) => void;
	/** Fired once when the underlying completion fails (e.g. GPU OOM, #11612). */
	onError?: (err: unknown) => void;
	postProcess?: (raw: string) => string;
}

export function streamCapacitorPrompt(
	args: StreamCapacitorPromptArgs,
): TextStreamResult {
	const queue: string[] = [];
	const streamFilter = createThinkTagStreamFilter();
	let pendingResolve: ((value: IteratorResult<string>) => void) | null = null;
	let pendingReject: ((reason: unknown) => void) | null = null;
	let promptError: unknown = null;
	let promptDone = false;
	let rawAccumulated = "";

	const drain = (): void => {
		if (!pendingResolve) return;
		if (queue.length > 0) {
			const next = queue.shift() as string;
			const resolver = pendingResolve;
			pendingResolve = null;
			pendingReject = null;
			resolver({ value: next, done: false });
			return;
		}
		if (promptError && pendingReject) {
			const rejector = pendingReject;
			pendingResolve = null;
			pendingReject = null;
			rejector(promptError);
			return;
		}
		if (promptDone) {
			const resolver = pendingResolve;
			pendingResolve = null;
			pendingReject = null;
			resolver({ value: undefined, done: true });
		}
	};

	let completionFinishReason: string | undefined;
	const completionPromise: Promise<CapacitorLlamaCompletionResult> =
		(async () => {
			try {
				const result = await args.ctx.completion(args.params, (tok) => {
					const piece = tok.token ?? tok.content ?? "";
					if (!piece) return;
					rawAccumulated += piece;
					const visibleChunks = streamFilter.push(piece);
					for (const visibleChunk of visibleChunks) {
						if (!visibleChunk) continue;
						args.onChunk?.(visibleChunk);
						queue.push(visibleChunk);
					}
					drain();
				});
				const tailChunks = streamFilter.flush();
				for (const visibleChunk of tailChunks) {
					if (!visibleChunk) continue;
					args.onChunk?.(visibleChunk);
					queue.push(visibleChunk);
				}
				if (result.stopped_eos) completionFinishReason = "stop";
				else if (result.stopped_word) completionFinishReason = "stop";
				else if (result.stopped_limit) completionFinishReason = "length";
				else if (result.interrupted) completionFinishReason = "abort";
				return result;
			} catch (err) {
				promptError = err;
				args.onError?.(err);
				throw err;
			} finally {
				promptDone = true;
				drain();
			}
		})();

	completionPromise.catch(() => {
		/* surfaced through textStream */
	});

	const textStream: AsyncIterable<string> = {
		[Symbol.asyncIterator](): AsyncIterator<string> {
			return {
				next(): Promise<IteratorResult<string>> {
					if (promptError) return Promise.reject(promptError);
					if (queue.length > 0) {
						const next = queue.shift() as string;
						return Promise.resolve({ value: next, done: false });
					}
					if (promptDone) {
						return Promise.resolve({
							value: undefined,
							done: true,
						});
					}
					return new Promise<IteratorResult<string>>((resolve, reject) => {
						pendingResolve = resolve;
						pendingReject = reject;
					});
				},
			};
		},
	};

	const fullTextPromise: Promise<string> = completionPromise.then((result) => {
		const raw = result.text.length > 0 ? result.text : rawAccumulated;
		return args.postProcess ? args.postProcess(raw) : raw;
	});

	const usagePromise: Promise<TokenUsage | undefined> = completionPromise
		.then((result) => {
			const usage: TokenUsage = {
				promptTokens: result.tokens_evaluated,
				completionTokens: result.tokens_predicted,
				totalTokens: result.tokens_evaluated + result.tokens_predicted,
			};
			// Surface to caller once.
			void fullTextPromise.then((fullText) =>
				args.onComplete?.({ fullText, usage }),
			);
			return usage;
		})
		// error-policy:J5 unhandled-rejection suppression — a completion failure
		// is observed by the `text`/`textStream` consumers (fullTextPromise does
		// not catch and rejects). `usage`/`finishReason` are optional metadata
		// that degrade to their typed `undefined`; the catch only prevents these
		// companion reads from surfacing the same failure a second time as an
		// unhandled rejection.
		.catch(() => undefined);

	const finishReasonPromise: Promise<string | undefined> = completionPromise
		.then(() => completionFinishReason ?? "stop")
		// error-policy:J5 unhandled-rejection suppression — see usagePromise above;
		// the completion failure surfaces via `text`/`textStream`.
		.catch(() => undefined);

	return {
		textStream,
		text: fullTextPromise,
		usage: usagePromise,
		finishReason: finishReasonPromise,
	};
}
