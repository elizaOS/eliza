/**
 * Fail-closed delivery gate for the external-content security envelope. The
 * envelope (`wrapExternalContent`) is prompt armor — it must never reach a
 * user, yet a model that echoes its prompt can hand the whole armor block to a
 * callback (live Discord leak 2026-08-02, tj-2dc95f75456876). Detection alone
 * proved insufficient: the tripwire reported the leak after the message
 * shipped. This guard runs at every pre-send seam core owns — the visible
 * callback wrap in `services/message.ts`, the mandatory
 * `outgoing_before_deliver` pipeline phase, and `sendMessageToTarget` — and
 * BLOCKS the send, replacing the text with a short honest notice while
 * `runtime.reportError` carries the clamped original for observability. The
 * MESSAGE_SENT tripwire in basic-capabilities stays as secondary,
 * report-only coverage for deliveries that bypass these seams.
 *
 * Blocking is deliberately variant-tolerant (`containsExternalEnvelopeMaterial`:
 * NFKC-folded, case-insensitive, partial/quoted/reference echoes): a user
 * asking about the marker syntax loses that one reply to the notice, which is
 * the accepted cost of never shipping armor.
 *
 * Streaming coverage: the message-service chunk seam holds a per-stream latch
 * ({@link createOutboundEnvelopeStreamLatch}) that stops chunk forwarding
 * (user stream callback + `model_stream_chunk` hook re-emission) once the
 * accumulated text reads as envelope material, and the first-sentence TTS
 * path refuses to synthesize or attach an envelope echo. KNOWN-OPEN seams:
 * chunks forwarded before the needle completes are already delivered (a
 * stream cannot be recalled), and `useModel`'s own `model_stream_chunk`
 * emission (`source: "use_model"`, runtime.ts) fires upstream of the latch
 * for direct-streaming callers outside the message service. The MESSAGE_SENT
 * tripwire in basic-capabilities is the report-only coverage for whatever
 * escapes those edges.
 */

import type { Media } from "../types/primitives.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../utils/well-formed.js";
import { containsExternalEnvelopeMaterial } from "./external-content.js";

/**
 * What a blocked delivery says instead of the leaked envelope. Honest about
 * what happened without echoing any of the blocked material.
 */
export const ENVELOPE_LEAK_NOTICE =
	"i caught an internal formatting leak and stopped it — try again.";

// Enough of the blocked text for an operator to identify the leak source
// without re-broadcasting a multi-KB envelope into the error ring.
const REPORT_PREVIEW_CHARS = 400;

/**
 * Report a blocked envelope delivery. One shape for every seam so the error
 * ring is greppable by scope and the preview never re-broadcasts a multi-KB
 * envelope.
 */
export function reportOutboundEnvelopeBlock(
	runtime: Pick<IAgentRuntime, "reportError">,
	blockedText: string,
	seam: string,
): void {
	runtime.reportError(
		"outbound-envelope-guard",
		new Error(
			"blocked outbound message carrying external-content envelope material",
		),
		{
			seam,
			blockedPreview: truncateWellFormed(
				toWellFormedUnicode(blockedText),
				REPORT_PREVIEW_CHARS,
			),
		},
	);
}

/**
 * Gate outbound text at a delivery seam. Clean text passes through untouched;
 * text carrying envelope material is replaced with {@link ENVELOPE_LEAK_NOTICE}
 * and reported. Never throws (reportError is the no-throw diagnostic
 * boundary), so a detected leak degrades to the notice instead of killing the
 * turn.
 */
export function guardOutboundEnvelopeText(
	runtime: Pick<IAgentRuntime, "reportError">,
	text: string,
	seam: string,
): string {
	if (!text || !containsExternalEnvelopeMaterial(text)) {
		return text;
	}
	reportOutboundEnvelopeBlock(runtime, text, seam);
	return ENVELOPE_LEAK_NOTICE;
}

/**
 * Gate attachment text at a delivery seam. Both voice paths in
 * `services/message.ts` deliver the spoken sentence as `attachment.text` on a
 * callback whose top-level `text` is empty — a text-only guard waves the
 * armor through inside the attachment. Attachments whose text carries
 * envelope material are dropped (there is no honest partial form of a leaked
 * attachment) and each drop is reported; clean input returns the same array
 * reference so callers can cheaply detect "nothing blocked".
 */
export function guardOutboundEnvelopeAttachments(
	runtime: Pick<IAgentRuntime, "reportError">,
	attachments: Media[],
	seam: string,
): Media[] {
	const safe = attachments.filter((attachment) => {
		const text = typeof attachment?.text === "string" ? attachment.text : "";
		if (!text || !containsExternalEnvelopeMaterial(text)) {
			return true;
		}
		reportOutboundEnvelopeBlock(runtime, text, seam);
		return false;
	});
	return safe.length === attachments.length ? attachments : safe;
}

/**
 * Per-stream latch for chunked deliveries. Returns a predicate over the
 * accumulated stream text: false while the stream is clean, true from the
 * moment the accumulation reads as envelope material — reported once on the
 * trip, then latched so the caller can stop forwarding every subsequent
 * chunk. Latching (rather than re-testing) matters because the envelope
 * needle, once present, stays present in the accumulation, and a per-chunk
 * re-report would flood the error ring token by token.
 */
export function createOutboundEnvelopeStreamLatch(
	runtime: Pick<IAgentRuntime, "reportError">,
	seam: string,
): (accumulated: string) => boolean {
	let tripped = false;
	return (accumulated: string): boolean => {
		if (tripped) {
			return true;
		}
		if (!accumulated || !containsExternalEnvelopeMaterial(accumulated)) {
			return false;
		}
		tripped = true;
		reportOutboundEnvelopeBlock(runtime, accumulated, seam);
		return true;
	};
}
