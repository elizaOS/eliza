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
 */

import type { IAgentRuntime } from "../types/runtime.ts";
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
	runtime.reportError(
		"outbound-envelope-guard",
		new Error(
			"blocked outbound message carrying external-content envelope material",
		),
		{ seam, blockedPreview: text.slice(0, REPORT_PREVIEW_CHARS) },
	);
	return ENVELOPE_LEAK_NOTICE;
}
