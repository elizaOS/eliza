/**
 * REPLY_CONTEXT provider — when the incoming message is an explicit reply to
 * an earlier message (`content.inReplyTo`), pulls that replied-to message plus
 * a small window of surrounding turns into the prompt so the model reads the
 * reply against the exchange it belongs to, not just the tail of the recent
 * transcript. The reply id reaches `content.inReplyTo` from the dashboard reply
 * affordance (the API boundary lifts `metadata.replyToMessageId` into it — see
 * packages/agent buildUserMessages) and from connectors that map platform reply
 * threading onto the field.
 *
 * Renders nothing on ordinary (non-reply) turns — the only cost on the happy
 * path is one field check. Surrounding turns already visible in the
 * RECENT_MESSAGES window are deduped away so the transcript is never repeated;
 * the replied-to message itself is always identified (one bounded line) because
 * the transcript format gives the model no other way to tell WHICH earlier
 * message the user meant. A reply id that resolves to another room is ignored —
 * same forged-pivot guard as the conversation `?around` window.
 */

import { isInternalBridgeMessage } from "../../../messaging/automated-turns.ts";
import type {
	CustomMetadata,
	Entity,
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	UUID,
} from "../../../types/index.ts";
import { addHeader, formatMessages, validateUuid } from "../../../utils.ts";

/** Turns fetched on EACH side of the replied-to message. */
export const REPLY_CONTEXT_WINDOW_RADIUS = 3;
/** Mirror of the RECENT_MESSAGES lookback ceiling, for the dedupe window. */
const MAX_RECENT_MESSAGES_LOOKBACK = 50;
/** Bound on the always-rendered replied-to snippet line. */
const MAX_REPLY_TARGET_SNIPPET_CHARS = 300;
/** Bound on each surrounding turn's rendered text. */
const MAX_REPLY_WINDOW_MESSAGE_CHARS = 1000;

const EMPTY_RESULT: ProviderResult = {
	data: { replyTargetMessage: null, replyContextMessages: [] },
	values: { replyContext: "" },
	text: "",
};

function memoryText(memory: Memory): string {
	return typeof memory.content.text === "string" ? memory.content.text : "";
}

function truncateSingleLine(text: string, maxChars: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > maxChars
		? `${collapsed.slice(0, maxChars)}…`
		: collapsed;
}

/** Cap a window turn's text so one giant pasted message can't blow up the prompt. */
function withBoundedText(memory: Memory): Memory {
	const text = memoryText(memory);
	if (text.length <= MAX_REPLY_WINDOW_MESSAGE_CHARS) return memory;
	return {
		...memory,
		content: {
			...memory.content,
			text: `${text.slice(0, MAX_REPLY_WINDOW_MESSAGE_CHARS)}…`,
		},
	};
}

function resolveSenderName(
	runtime: IAgentRuntime,
	memory: Memory,
	entities: Entity[],
): string {
	if (memory.entityId === runtime.agentId) {
		return runtime.character.name ?? "Agent";
	}
	const entity = entities.find((e) => e.id === memory.entityId);
	if (entity?.names?.[0]) return entity.names[0];
	const metadata = memory.metadata as CustomMetadata | undefined;
	return typeof metadata?.entityName === "string" && metadata.entityName.trim()
		? metadata.entityName.trim()
		: "Unknown User";
}

/**
 * Fill in entities for window senders who are no longer room participants
 * (the replied-to exchange can predate the current member list), mirroring the
 * RECENT_MESSAGES backfill so formatting never degrades to "Unknown User" for
 * a resolvable sender.
 */
async function backfillEntities(
	runtime: IAgentRuntime,
	entities: Entity[],
	messages: Memory[],
): Promise<Entity[]> {
	const known = new Set(entities.map((e) => e.id));
	const missing = [
		...new Set(
			messages
				.map((m) => m.entityId)
				.filter((id): id is UUID => Boolean(id) && !known.has(id)),
		),
	];
	if (missing.length === 0) return entities;
	const resolved = await Promise.all(
		missing.map((id) => runtime.getEntityById(id)),
	);
	return [...entities, ...resolved.filter((e): e is Entity => e !== null)];
}

export const replyContextProvider: Provider = {
	name: "REPLY_CONTEXT",
	description:
		"Focused context for an explicit reply-to turn: identifies the replied-to message and pulls the surrounding turns that are not already in the recent transcript window.",
	position: 110,
	dynamic: true,
	// Reply context must reach Stage 1 (and the simple reply path) whenever the
	// incoming turn carries a reply id; it renders empty otherwise, so always-on
	// composition costs one field check on non-reply turns.
	alwaysInResponseState: true,

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<ProviderResult> => {
		const inReplyTo = validateUuid(message.content.inReplyTo);
		if (!inReplyTo) return EMPTY_RESULT;

		const { roomId } = message;
		const [target] = await runtime.getMemoriesByIds([inReplyTo], "messages");
		// Missing target (deleted / never persisted) or a forged id pointing at
		// another room: render nothing rather than leak cross-room content.
		if (!target?.id || target.roomId !== roomId) return EMPTY_RESULT;

		const targetCreatedAt = target.createdAt ?? 0;
		const recentWindowLength = Math.min(
			runtime.getConversationLength(),
			MAX_RECENT_MESSAGES_LOOKBACK,
		);
		const [recentWindow, olderOrAt, newerOrAt] = await Promise.all([
			// The same window RECENT_MESSAGES renders, fetched for dedupe: any
			// surrounding turn already in it is visible in the transcript above.
			runtime.getMemories({
				tableName: "messages",
				roomId,
				limit: recentWindowLength,
				unique: false,
			}),
			// The target and up to RADIUS older turns (end is inclusive).
			runtime.getMemories({
				tableName: "messages",
				roomId,
				end: targetCreatedAt,
				limit: REPLY_CONTEXT_WINDOW_RADIUS + 1,
				orderBy: "createdAt",
				orderDirection: "desc",
			}),
			// The target and up to RADIUS newer turns (start is inclusive).
			runtime.getMemories({
				tableName: "messages",
				roomId,
				start: targetCreatedAt,
				limit: REPLY_CONTEXT_WINDOW_RADIUS + 1,
				orderBy: "createdAt",
				orderDirection: "asc",
			}),
		]);

		const recentIds = new Set(
			recentWindow.map((m) => m.id).filter((id): id is UUID => Boolean(id)),
		);

		// Merge the half-windows (both include the target; createdAt ties may
		// overlap further), drop rows the transcript already shows, drop the
		// incoming message itself, and keep only real dialogue.
		const byId = new Map<UUID, Memory>();
		for (const row of [...olderOrAt, ...newerOrAt]) {
			if (!row.id || row.id === message.id) continue;
			if (recentIds.has(row.id)) continue;
			if (row.content.type === "action_result") continue;
			if (isInternalBridgeMessage(row)) continue;
			if (!memoryText(row).trim()) continue;
			byId.set(row.id, row);
		}
		const contextMessages = [...byId.values()].sort(
			(a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
		);

		const entities = await backfillEntities(
			runtime,
			await runtime.getEntitiesForRoom(roomId),
			[target, ...contextMessages],
		);

		const targetSender = resolveSenderName(runtime, target, entities);
		const targetSnippet = truncateSingleLine(
			memoryText(target),
			MAX_REPLY_TARGET_SNIPPET_CHARS,
		);
		const lines = [
			`The incoming message is a direct reply to this earlier message from ${targetSender}:`,
			`> ${targetSender}: ${targetSnippet || "(no text content)"}`,
		];
		if (contextMessages.length > 0) {
			// formatMessages renders its input back-to-front, so hand it the window
			// newest-first to get an oldest-first block the model reads top-down.
			const formattedWindow = formatMessages({
				messages: contextMessages.map(withBoundedText).reverse(),
				entities,
			});
			lines.push(
				"",
				"Surrounding messages from that point in the conversation (older than the recent transcript above, oldest first):",
				formattedWindow,
			);
		} else if (recentIds.has(target.id)) {
			lines.push(
				"(The replied-to message and its surrounding turns already appear in the recent conversation above.)",
			);
		}

		const text = addHeader("# Replied-To Message Context", lines.join("\n"));
		return {
			data: {
				replyTargetMessage: target,
				replyContextMessages: contextMessages,
			},
			values: { replyContext: text },
			text,
		};
	},
};
