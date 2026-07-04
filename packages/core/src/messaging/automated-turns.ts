/**
 * Structural classifiers for message turns authored by automation rather than
 * a human speaker. Two independent signals, both stamped structurally (never
 * inferred from message text):
 *
 *   - internal bridge rows — messages injected by the agent's own machinery
 *     (sub-agent relay, swarm synthesis), identified by `content.source` or
 *     sub-agent metadata; and
 *   - connector-stamped bot/webhook authorship — the `fromBot` metadata flag
 *     connectors set at ingestion for webhook and bot-account senders.
 *
 * Prompt-composition consumers gate on these: RECENT_MESSAGES strips bridge
 * rows from the transcript, FACTS skips room-scoped fact pools for automated
 * senders (room facts describe other participants and must not be attributed
 * to a relay bot), and the composeState onlyInclude path enforces provider
 * roleGates for automated senders. Absence of every signal means the turn is
 * treated as human — connectors that stamp nothing keep today's behavior.
 */
import type { Memory } from "../types/memory";

export const INTERNAL_BRIDGE_MESSAGE_SOURCES: ReadonlySet<string> = new Set([
	"acpx:sub-agent-router",
	"swarm_synthesis",
]);

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Message injected by the agent's own sub-agent/swarm bridge machinery. */
export function isInternalBridgeMessage(memory: Memory): boolean {
	const source =
		typeof memory.content?.source === "string"
			? memory.content.source.trim()
			: "";
	if (INTERNAL_BRIDGE_MESSAGE_SOURCES.has(source)) {
		return true;
	}
	return metadataRecord(memory.content?.metadata)?.subAgent === true;
}

/** Message whose sender the connector positively stamped as a bot/webhook. */
export function isBotAuthoredMessage(memory: Memory): boolean {
	return (
		metadataRecord(memory.content?.metadata)?.fromBot === true ||
		metadataRecord(memory.metadata)?.fromBot === true
	);
}

/** Either automation signal — the turn was not authored by a human speaker. */
export function isAutomatedSenderTurn(memory: Memory): boolean {
	return isBotAuthoredMessage(memory) || isInternalBridgeMessage(memory);
}
