/**
 * SSE response transformation.
 *
 * Tail-buffer reverseMap to handle patterns split across TCP chunk boundaries.
 * Without this, "ocplatform" can split as "ocp"+"latform" and leak through.
 * TAIL_SIZE >= longest reverseMap pattern.
 *
 * Also uses StringDecoder to buffer incomplete UTF-8 sequences across TCP
 * chunks. chunk.toString() would emit U+FFFD whenever a multi-byte char
 * (中文, emoji, etc.) lands on a chunk boundary.
 *
 * Defends against splitting a UTF-16 surrogate pair (4-byte UTF-8 chars like
 * emoji).
 */

import { StringDecoder } from "node:string_decoder";

export const SSE_TAIL_SIZE = 64;

export type ReverseFn = (text: string) => string;

export interface SseStream {
	write: (chunk: Buffer) => void;
	end: () => void;
}

export function createSseStream(
	reverseFn: ReverseFn,
	emit: (text: string) => void,
	finish: () => void,
): SseStream {
	const decoder = new StringDecoder("utf8");
	let pending = "";

	return {
		write(chunk: Buffer): void {
			pending += decoder.write(chunk);
			if (pending.length > SSE_TAIL_SIZE) {
				let sliceIdx = pending.length - SSE_TAIL_SIZE;
				// Don't cut between a UTF-16 surrogate pair
				const prev = pending.charCodeAt(sliceIdx - 1);
				if (prev >= 0xd800 && prev <= 0xdbff) sliceIdx -= 1;
				const flushable = pending.slice(0, sliceIdx);
				pending = pending.slice(sliceIdx);
				emit(reverseFn(flushable));
			}
		},
		end(): void {
			pending += decoder.end();
			if (pending.length > 0) {
				emit(reverseFn(pending));
			}
			finish();
		},
	};
}
