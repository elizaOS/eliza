import type { Room } from "../types/environment.ts";
import type { Memory } from "../types/memory.ts";
import type { ContextRoutedResponseDecision } from "../types/message-service.ts";
import type { MentionContext, UUID } from "../types/primitives.ts";
import { ChannelType } from "../types/primitives.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import {
	buildNameRegistryForRoom,
	NameVariationRegistry,
} from "./name-variation-registry.ts";

export function isPrivateChannelRoom(room: Room): boolean {
	const t = room.type;
	return (
		t === ChannelType.DM ||
		t === ChannelType.VOICE_DM ||
		t === ChannelType.SELF ||
		t === ChannelType.API
	);
}

/** Merge optional routing hints from content and message metadata (documented adapter fields). */
export function mergeMessageRoutingMetadata(
	message: Memory,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const content = message.content as Record<string, unknown>;
	for (const key of [
		"replyToEntityId",
		"inReplyToEntityId",
		"replyTo",
		"inReplyTo",
	] as const) {
		if (content[key] !== undefined && content[key] !== null) {
			out[key] = content[key];
		}
	}
	const meta = message.metadata as Record<string, unknown> | undefined;
	if (meta) {
		for (const key of [
			"replyToEntityId",
			"inReplyToEntityId",
			"replyTo",
			"inReplyTo",
		] as const) {
			if (meta[key] !== undefined && meta[key] !== null) {
				out[key] = meta[key];
			}
		}
	}
	return out;
}

export async function fetchParentMessageAuthorEntityId(
	runtime: IAgentRuntime,
	parentMessageId: UUID | undefined,
): Promise<UUID | null> {
	if (!parentMessageId) return null;
	const parent = await runtime.getMemoryById(parentMessageId);
	if (!parent?.entityId) return null;
	return parent.entityId;
}

/**
 * Non-LLM overrides for group rooms: explicit addressee to another agent, or text that addresses this agent in a reply-to-other thread.
 */
export async function evaluateGroupAddresseeOverride(
	runtime: IAgentRuntime,
	message: Memory,
	room: Room,
	mentionContext: MentionContext | undefined,
	parentMessageAuthorEntityId: UUID | null | undefined,
): Promise<ContextRoutedResponseDecision | null> {
	if (isPrivateChannelRoom(room)) return null;
	if (mentionContext?.isMention) return null;

	const myId = runtime.agentId;
	const text = message.content.text ?? "";
	const routingMeta = mergeMessageRoutingMetadata(message);
	const roomId = room.id;
	if (!roomId) return null;

	let registry: NameVariationRegistry | null = null;
	const loadRegistry = async () => {
		if (!registry) {
			try {
				registry = await buildNameRegistryForRoom(runtime, roomId);
			} catch {
				registry = new NameVariationRegistry();
			}
		}
		return registry;
	};

	if (mentionContext?.isReply) {
		if (parentMessageAuthorEntityId === myId) {
			return null;
		}
		if (
			parentMessageAuthorEntityId != null &&
			parentMessageAuthorEntityId !== myId
		) {
			const reg = await loadRegistry();
			if (reg.isAddressedToSelf(text, myId, routingMeta)) {
				return {
					shouldRespond: true,
					skipEvaluation: true,
					reason: "reply thread; text addresses this agent",
					primaryContext: "general",
				};
			}
			if (reg.isAddressedToOther(text, myId, routingMeta)) {
				return {
					shouldRespond: false,
					skipEvaluation: true,
					reason: "addressed to other agent (reply thread)",
					primaryContext: "general",
				};
			}
			return null;
		}
		return null;
	}

	if (!text.trim()) return null;
	const reg = await loadRegistry();
	if (reg.isAddressedToOther(text, myId, routingMeta)) {
		return {
			shouldRespond: false,
			skipEvaluation: true,
			reason: "addressed to other agent",
			primaryContext: "general",
		};
	}
	return null;
}
