/**
 * Validates deferred-message epoch timestamps and renders their canonical ISO
 * representation before a scheduling collaborator or store can observe them.
 */

import { ElizaError } from "../../../errors.ts";

export function formatSendAtIso(sendAtMs: number): string {
	if (!Number.isFinite(sendAtMs)) {
		throw new ElizaError(
			`Invalid sendAtMs: ${String(sendAtMs)} is not finite`,
			{
				code: "MESSAGE_DRAFT_SCHEDULE_INVALID_TIME",
				context: { sendAtMs },
			},
		);
	}
	const date = new Date(sendAtMs);
	if (Number.isNaN(date.getTime())) {
		throw new ElizaError(
			`Invalid sendAtMs: ${String(sendAtMs)} is out of Date range`,
			{
				code: "MESSAGE_DRAFT_SCHEDULE_INVALID_TIME",
				context: { sendAtMs },
			},
		);
	}
	return date.toISOString();
}
