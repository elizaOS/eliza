/**
 * Shared room-state signal helpers for the group-chat social providers
 * (ANXIETY and BOT_AWARENESS). Everything here is deterministic arithmetic
 * over the already-composed recent-messages window — no model calls, no
 * embeddings, and no new DB round-trips on the hot path: when the turn state
 * does not yet carry RECENT_MESSAGES data (first compose of a turn), the
 * fallback `runtime.getMemories` room-scan is exactly the shape the runtime's
 * turn-scoped single-flight memo coalesces (see
 * `runtime.ts#coalesceRoomMessagesScan`), so it shares the one superset fetch
 * RECENT_MESSAGES/FACTS/ATTACHMENTS already issue instead of adding a query.
 *
 * Multi-party eligibility is deliberately group-only: Shaw + Shadow's ask was
 * "just group chat" — DMs must stay inert, so both consumers gate on
 * `isMultiPartyChannel` before computing anything.
 */

import { isInternalBridgeMessage } from "../../../messaging/automated-turns.ts";
import { getRecentMessagesData } from "../../../recent-messages-state.ts";
import type {
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";

/**
 * Channel types where more than two parties can hold the floor. Mirrors the
 * Stage-1 text-group set (stage1-prompt-tier.ts) minus FEED (post-style, no
 * turn-taking) plus VOICE_GROUP (multi-party voice rooms have the same
 * talked-too-much failure mode). DM / VOICE_DM / SELF / API are deliberately
 * absent: these signals must never fire in private conversations.
 */
const MULTI_PARTY_CHANNEL_TYPES: ReadonlySet<string> = new Set([
	String(ChannelType.GROUP),
	String(ChannelType.VOICE_GROUP),
	String(ChannelType.THREAD),
	String(ChannelType.WORLD),
	String(ChannelType.FORUM),
]);

/** Bounded evidence window; matches the coalesced-scan floor so the fallback
 * fetch never widens the shared superset window. */
export const GROUP_SIGNAL_WINDOW = 20;

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Connector-stamped bot authorship — the same ground-truth signal the
 * transcript formatter (`utils.ts#formatMessages` "Name (bot)" tag) and the
 * bot-noise triage gate read. Untagged senders are treated as human, so a
 * connector that omits the stamp degrades to normal behavior.
 */
export function isBotAuthoredMessage(message: Memory): boolean {
	return (
		metadataRecord(message.metadata)?.fromBot === true ||
		metadataRecord(message.content?.metadata)?.fromBot === true
	);
}

/** Resolve the effective channel type: inbound content first, room row second. */
export async function resolveChannelType(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<string> {
	const fromContent = message.content?.channelType;
	if (typeof fromContent === "string" && fromContent.trim() !== "") {
		return fromContent.trim().toUpperCase();
	}
	if (!message.roomId) return "";
	try {
		// Coalesced by the runtime's turn-scoped getRoom memo — no extra
		// round-trip within a compose fan-out.
		const room = await runtime.getRoom(message.roomId);
		return room?.type ? String(room.type).trim().toUpperCase() : "";
	} catch {
		return "";
	}
}

export function isMultiPartyChannel(channelType: string): boolean {
	return MULTI_PARTY_CHANNEL_TYPES.has(channelType);
}

function isDialogueMessage(memory: Memory): boolean {
	return (
		memory.content?.type !== "action_result" && !isInternalBridgeMessage(memory)
	);
}

/**
 * Chronological (oldest-first) comparator for the dialogue window. Ascending
 * order is load-bearing: `loadDialogueWindow` keeps the newest turns with
 * `.slice(-GROUP_SIGNAL_WINDOW)`, appends the live inbound turn at the tail,
 * and `computeGroupConversationMetrics` reads the tail as the most recent
 * turns (ping-pong run, turns-since-last-human).
 *
 * A non-finite `createdAt` reaching this comparator from an adapter row would
 * make the raw subtraction return NaN, which `Array.prototype.sort` treats as
 * "leave as is" and which corrupts the ordering of every pair it touches — not
 * just the bad row. Non-finite stamps therefore collapse to 0 (sorted as the
 * oldest possible turn) and ties break on `id` so the window is deterministic.
 */
function compareByCreatedAtAscending(a: Memory, b: Memory): number {
	const aSafe = createdAtSortKey(a);
	const bSafe = createdAtSortKey(b);
	if (aSafe !== bSafe) return aSafe - bSafe;
	return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

function createdAtSortKey(memory: Memory): number {
	const value = memory.createdAt;
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Load the bounded dialogue window for signal computation. Prefers the
 * RECENT_MESSAGES provider's already-composed array (turn recompose); falls
 * back to the coalesced room messages-scan on the first compose of a turn.
 * The current inbound message is appended when the stored window does not
 * already contain it, so tail signals always see the live turn.
 */
export async function loadDialogueWindow(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
): Promise<Memory[]> {
	const composed = getRecentMessagesData(state);
	let source: Memory[];
	if (composed.length > 0) {
		source = composed;
	} else if (message.roomId) {
		try {
			source = await runtime.getMemories({
				tableName: "messages",
				roomId: message.roomId,
				limit: GROUP_SIGNAL_WINDOW,
				unique: false,
			});
		} catch {
			source = [];
		}
	} else {
		source = [];
	}
	const window = source
		.filter(isDialogueMessage)
		.sort(compareByCreatedAtAscending)
		.slice(-GROUP_SIGNAL_WINDOW);
	const hasInbound =
		message.id !== undefined && window.some((entry) => entry.id === message.id);
	if (!hasInbound && isDialogueMessage(message)) {
		window.push(message);
	}
	return window.slice(-GROUP_SIGNAL_WINDOW);
}

export interface GroupConversationMetrics {
	/** Dialogue turns considered (bounded by GROUP_SIGNAL_WINDOW). */
	windowSize: number;
	/** Turns in the window authored by this agent. */
	agentTurns: number;
	/** agentTurns / windowSize (0 when the window is empty). */
	agentShare: number;
	/** Distinct non-agent senders seen in the window. */
	participantCount: number;
	/** Agent turns inside the strict agent↔single-other alternation ending the window. */
	pingPongRun: number;
	/** Whether the latest inbound turn is connector-stamped bot-authored. */
	latestFromBot: boolean;
	/** Agent turns since the last human (non-agent, non-bot) turn in the window. */
	agentTurnsSinceLastHuman: number;
	/** Bot-authored turns since the last human turn in the window. */
	botTurnsSinceLastHuman: number;
	/** Whether any human turn exists inside the window at all. */
	humanInWindow: boolean;
}

/**
 * Compute the evidence signals both providers read. Pure function over the
 * dialogue window; the agent's own turns are identified by entityId.
 */
export function computeGroupConversationMetrics(
	window: Memory[],
	agentId: UUID,
): GroupConversationMetrics {
	const windowSize = window.length;
	let agentTurns = 0;
	const participants = new Set<string>();
	for (const entry of window) {
		if (entry.entityId === agentId) {
			agentTurns += 1;
		} else if (entry.entityId) {
			participants.add(String(entry.entityId));
		}
	}

	// Strict tail alternation between the agent and ONE other sender:
	// … agent, X, agent, X — the ping-pong shape. Counts the agent's turns in
	// that suffix; breaks on any third party or a repeated speaker.
	let pingPongRun = 0;
	let otherParty: string | null = null;
	let previousWasAgent: boolean | null = null;
	for (let i = window.length - 1; i >= 0; i -= 1) {
		const entry = window[i];
		const isAgent = entry.entityId === agentId;
		if (!isAgent) {
			const sender = entry.entityId ? String(entry.entityId) : null;
			if (!sender) break;
			if (otherParty === null) {
				otherParty = sender;
			} else if (otherParty !== sender) {
				break;
			}
		}
		if (previousWasAgent !== null && previousWasAgent === isAgent) {
			break;
		}
		previousWasAgent = isAgent;
		if (isAgent) pingPongRun += 1;
	}

	// Gap since the last human turn (human = not this agent, not bot-stamped).
	let agentTurnsSinceLastHuman = 0;
	let botTurnsSinceLastHuman = 0;
	let humanInWindow = false;
	for (let i = window.length - 1; i >= 0; i -= 1) {
		const entry = window[i];
		if (entry.entityId === agentId) {
			agentTurnsSinceLastHuman += 1;
			continue;
		}
		if (isBotAuthoredMessage(entry)) {
			botTurnsSinceLastHuman += 1;
			continue;
		}
		humanInWindow = true;
		break;
	}
	if (!humanInWindow) {
		humanInWindow = window.some(
			(entry) => entry.entityId !== agentId && !isBotAuthoredMessage(entry),
		);
	}

	const latest = window[window.length - 1];
	return {
		windowSize,
		agentTurns,
		agentShare: windowSize > 0 ? agentTurns / windowSize : 0,
		participantCount: participants.size,
		pingPongRun,
		latestFromBot: latest ? isBotAuthoredMessage(latest) : false,
		agentTurnsSinceLastHuman,
		botTurnsSinceLastHuman,
		humanInWindow,
	};
}

/**
 * Structural "a human just addressed the agent" dampener: platform mention or
 * reply, or the agent's configured name appearing as a whole word in the
 * inbound text — and the inbound sender is not itself a bot. Deliberately a
 * lightweight mirror of the Stage-1 addressing signal (services/message.ts):
 * providers cannot import that module without an import cycle, and this
 * dampener only relaxes advisory guidance, never gates a response.
 */
export function humanDirectlyAddressesAgent(
	runtime: IAgentRuntime,
	message: Memory,
): boolean {
	if (isBotAuthoredMessage(message)) return false;
	const mentionContext = message.content?.mentionContext;
	if (mentionContext?.isMention === true || mentionContext?.isReply === true) {
		return true;
	}
	const text = message.content?.text;
	if (!text) return false;
	const names = [runtime.character?.name, runtime.character?.username];
	for (const name of names) {
		const candidate = typeof name === "string" ? name.trim() : "";
		if (candidate.length < 2) continue;
		const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(
			`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`,
			"iu",
		);
		if (pattern.test(text)) return true;
	}
	return false;
}
