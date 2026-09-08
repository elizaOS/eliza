/** Classifies message addressing and ambient response policy from explicit message, room, and role inputs. */

import {
	type ReplyGateMode,
	resolveEffectiveReplyGate,
} from "../../features/advanced-capabilities/personality";
import { getPersonalityStore } from "../../features/advanced-capabilities/personality/services/personality-store.ts";
import { checkSenderRole, getUnresolvedSenderRoleFloor } from "../../roles";
import type { ContextRegistry } from "../../runtime/context-registry";
import type { ContextDefinition, RoleGateRole } from "../../types/contexts";
import type { Memory } from "../../types/memory";
import {
	MESSAGE_SOURCE_CLIENT_CHAT,
	MESSAGE_SOURCE_TRIGGER_PROMPT,
} from "../../types/message-source";
import { ChannelType } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import { getUserMessageText } from "../../utils/message-text";
import { isUnaddressedTextGroupTurn } from "./stage1-prompt-tier";

export function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const NON_DISTINCTIVE_AGENT_NAME_TOKENS = new Set([
	"agent",
	"assistant",
	"bot",
	"chatbot",
	"demo",
	"helper",
	"system",
	"test",
]);

/** Returns whether text names the agent through a complete configured alias or
 * a distinctive token from a multi-word alias. */
export function textContainsAgentName(
	text: string | undefined,
	names: Array<string | null | undefined>,
): boolean {
	if (!text) {
		return false;
	}

	// A multi-word agent name is addressed by any of its distinctive tokens:
	// "remilio nubilio" answers to "nubilio …" (live 2026-08-22: the full-phrase
	// match classified "nubilio whats the setting …" as ambient, arming the
	// engagement gate on a message that literally opens with the agent's name).
	// Short fragments and generic role/test words stay excluded because length
	// alone does not make "agent", "assistant", or "test" an identity signal.
	// The complete configured name/username remains authoritative even when one
	// of its component words is generic.
	const candidates = new Set<string>();
	for (const name of names) {
		const candidate = name?.trim();
		if (!candidate) continue;
		candidates.add(candidate);
		for (const token of candidate.split(/\s+/u)) {
			if (
				token.length >= 4 &&
				!NON_DISTINCTIVE_AGENT_NAME_TOKENS.has(token.toLowerCase())
			) {
				candidates.add(token);
			}
		}
	}

	return [...candidates].some((candidate) => {
		const pattern = new RegExp(
			`(^|[^\\p{L}\\p{N}])${escapeRegex(candidate)}(?=$|[^\\p{L}\\p{N}])`,
			"iu",
		);
		return pattern.test(text);
	});
}

export function textContainsUserTag(text: string | undefined): boolean {
	if (!text) {
		return false;
	}

	return /<@!?[^>]+>|@\w+/u.test(text);
}

/**
 * Structural "this message addresses the agent" signal: platform mention,
 * platform reply-to-agent, or the agent's name/username appearing in the
 * text. Shared by the reply gate, the bot-noise TEXT_SMALL triage, and the
 * Stage-1 prompt tier so all three branch on the same ground truth.
 */
export interface MessageAddressSignals {
	platformMention: boolean;
	replyToAgent: boolean;
	textualAgentName: boolean;
	effective: boolean;
}

export function textDirectlyAddressesAgentName(
	text: string | undefined,
	names: Array<string | null | undefined>,
): boolean {
	if (!text) return false;
	return names.some((name) => {
		const candidate = name?.trim();
		if (!candidate) return false;
		const escaped = escapeRegex(candidate);
		if (
			new RegExp(`,\\s*@?${escaped}(?=\\s|$)`, "iu").test(text) ||
			new RegExp(
				`^\\s*(?:ok(?:ay)?|thanks?|thank you)\\s*,?\\s*@?${escaped}\\s*[.!?]*\\s*$`,
				"iu",
			).test(text)
		) {
			return true;
		}
		const leading = text.match(
			new RegExp(
				`^\\s*(?:(?:hey|hi|hello|thanks?|thank you|please)\\s*[,!:;-]?\\s*)?@?${escaped}(?<rest>(?:$|[^\\p{L}\\p{N}][\\s\\S]*))$`,
				"iu",
			),
		);
		if (!leading?.groups) return false;
		const rest = leading.groups.rest.trim();
		if (!rest || /^[,!:;?-]/u.test(rest) || /[?]$/u.test(rest)) return true;
		// A name-led imperative is a direct address regardless of its verb. Only
		// reject clear third-person continuations; this avoids a brittle allowlist
		// that makes ordinary commands such as "Eliza summarize that" ambient.
		return !/^(?:is|was|were|has|had|said|says|thinks|thought|seems|look(?:s|ed)|does|did)\b/iu.test(
			rest,
		);
	});
}

/** Classifies the structural signals used by Stage 1 to distinguish addressed from ambient turns. */
export function classifyMessageAddress(
	runtime: IAgentRuntime,
	message: Memory,
): MessageAddressSignals {
	const mentionContext = message.content?.mentionContext;
	const platformMention = mentionContext?.isMention === true;
	const replyToAgent = mentionContext?.isReply === true;
	const textualAgentName = textDirectlyAddressesAgentName(
		message.content?.text,
		[runtime.character?.name, runtime.character?.username],
	);
	return {
		platformMention,
		replyToAgent,
		textualAgentName,
		effective: platformMention || replyToAgent || textualAgentName,
	};
}

export function messageExplicitlyAddressesAgent(
	runtime: IAgentRuntime,
	message: Memory,
): boolean {
	return classifyMessageAddress(runtime, message).effective;
}

/** Detects a current-turn challenge that directly continues the agent's prior reply. */
export function messageChallengesPriorAgentReply(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
): boolean {
	const providers = state.data?.providers;
	if (!providers || typeof providers !== "object") return false;
	const recent = (providers as Record<string, unknown>).RECENT_MESSAGES;
	if (!recent || typeof recent !== "object") return false;
	const data = (recent as { data?: unknown }).data;
	const recentMessages =
		data && typeof data === "object" && "recentMessages" in data
			? (data as { recentMessages?: unknown }).recentMessages
			: undefined;
	if (!Array.isArray(recentMessages)) return false;
	const prior = [...recentMessages]
		.reverse()
		.find((candidate): candidate is Memory => {
			if (!candidate || typeof candidate !== "object") return false;
			const memory = candidate as Memory;
			return !message.id || memory.id !== message.id;
		});
	if (prior?.entityId !== runtime.agentId) return false;
	const text = getUserMessageText(message) ?? "";
	return /\b(counterintuitive|disagree|doubt|wrong|incorrect|confus(?:ed|ing)|clarify|actually|but i thought|i thought|are you sure|really|why)\b/iu.test(
		text,
	);
}

/** Detects a same-speaker continuation immediately after peers corrected this agent's behavior. */
export function messageContinuesAfterRecentAgentCorrection(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
): boolean {
	const providers = state.data?.providers;
	if (!providers || typeof providers !== "object") return false;
	const recent = (providers as Record<string, unknown>).RECENT_MESSAGES;
	if (!recent || typeof recent !== "object") return false;
	const data = (recent as { data?: unknown }).data;
	const recentMessages =
		data && typeof data === "object" && "recentMessages" in data
			? (data as { recentMessages?: unknown }).recentMessages
			: undefined;
	if (!Array.isArray(recentMessages) || !message.id) return false;
	const priorMessages = recentMessages.filter(
		(candidate): candidate is Memory =>
			candidate !== null &&
			typeof candidate === "object" &&
			(candidate as Memory).id !== message.id,
	);
	let lastAgentIndex = -1;
	for (let index = priorMessages.length - 1; index >= 0; index -= 1) {
		if (priorMessages[index].entityId === runtime.agentId) {
			lastAgentIndex = index;
			break;
		}
	}
	if (lastAgentIndex < 0) return false;
	const turnsAfterAgent = priorMessages.slice(lastAgentIndex + 1);
	// Repair ownership expires when the room has moved on; this is an adjacency
	// signal, not permission to revive an old correction on later ambient turns.
	if (turnsAfterAgent.length === 0 || turnsAfterAgent.length > 3) return false;
	const correction = turnsAfterAgent[0];
	if (
		correction.entityId !== message.entityId ||
		correction.entityId === runtime.agentId
	) {
		return false;
	}
	// Only a directive that begins as the speaker's own behavioral correction
	// establishes repair ownership. Anchoring the directive rejects third-party
	// exchanges such as "Bob, stop explaining" that merely follow an agent turn.
	const explicitBehaviorCorrection =
		/^\s*(?:(?:please\s+)?(?:don't|do not)\s+(?:try\s+to\s+)?(?:fix|solve|advise|recommend|suggest|coach|lecture|explain|give\s+(?:me|us)\s+advice)|stop\s+(?:trying\s+to\s+)?(?:fixing|solving|advising|recommending|suggesting|coaching|lecturing|explaining|giving\s+(?:me|us)\s+advice))\b/iu;
	if (!explicitBehaviorCorrection.test(getUserMessageText(correction) ?? "")) {
		return false;
	}
	const correctionCreatedAt = correction.createdAt;
	const currentCreatedAt = message.createdAt;
	if (
		typeof correctionCreatedAt === "number" &&
		typeof currentCreatedAt === "number" &&
		currentCreatedAt - correctionCreatedAt > 15 * 60_000
	) {
		return false;
	}
	// A correction grants one later turn to its author. Once that participant
	// has spoken again, later ambient messages must pass the ordinary gate.
	if (
		turnsAfterAgent
			.slice(1)
			.some((candidate) => candidate.entityId === message.entityId)
	) {
		return false;
	}
	const currentText = (getUserMessageText(message) ?? "").trim();
	return /^(?:and\b|also\b|plus\b|yeah\b|honestly\b|still\b|then\b|i\s+(?:just|also|keep|remembered|feel|felt|was|am)\b)/iu.test(
		currentText,
	);
}

/**
 * Resolves the sender's effective personality `reply_gate` mode (user slot →
 * global slot) for the post-Stage-1 engagement addressing gate. An explicit
 * `"always"` is the deliberate opt-out that keeps intentionally-chatty agents
 * replying even to turns addressed to another participant; every other mode —
 * including the default unset state — leaves that gate armed.
 */
export function resolveStage1ReplyGateMode(
	runtime: IAgentRuntime,
	message: Memory,
): ReplyGateMode | null {
	if (typeof runtime.getService !== "function") return null;
	const store = getPersonalityStore(runtime);
	if (!store || message.entityId === runtime.agentId) {
		return null;
	}
	return resolveEffectiveReplyGate(
		store.getSlot(message.entityId),
		store.getSlot("global"),
	).mode;
}

export const BUILTIN_ALWAYS_RESPOND_CHANNELS: readonly ChannelType[] = [
	ChannelType.DM,
	ChannelType.VOICE_DM,
	ChannelType.SELF,
	ChannelType.API,
];

export const BUILTIN_ALWAYS_RESPOND_SOURCES: readonly string[] = [
	MESSAGE_SOURCE_CLIENT_CHAT,
	MESSAGE_SOURCE_TRIGGER_PROMPT,
];

export function normalizeResponseBypassList(value: unknown): string[] {
	if (typeof value !== "string") return [];
	return value
		.trim()
		.replace(/^\[|\]$/g, "")
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
}

/**
 * Canonical structural response bypass used before Stage 1 and by the legacy
 * response gate. A bypassed turn must never receive an ambient-silence prompt
 * that contradicts the routing contract which guarantees a response.
 */
export function messageBypassesResponseEvaluation(
	runtime: IAgentRuntime,
	message: Memory,
): boolean {
	const configuredChannels = normalizeResponseBypassList(
		runtime.getSetting("ALWAYS_RESPOND_CHANNELS") ??
			runtime.getSetting("SHOULD_RESPOND_BYPASS_TYPES"),
	);
	const configuredSources = normalizeResponseBypassList(
		runtime.getSetting("ALWAYS_RESPOND_SOURCES") ??
			runtime.getSetting("SHOULD_RESPOND_BYPASS_SOURCES"),
	);
	const channel = String(message.content?.channelType ?? "")
		.trim()
		.toLowerCase();
	const source = String(message.content?.source ?? "")
		.trim()
		.toLowerCase();
	const channels = [
		...BUILTIN_ALWAYS_RESPOND_CHANNELS.map((entry) =>
			String(entry).toLowerCase(),
		),
		...configuredChannels,
	];
	const sources = [
		...BUILTIN_ALWAYS_RESPOND_SOURCES.map((entry) => entry.toLowerCase()),
		...configuredSources,
	];
	return (
		channels.includes(channel) ||
		sources.some((pattern) => pattern.length > 0 && source.includes(pattern))
	);
}

/**
 * Whether an ambient (unaddressed group) turn should carry the restrained
 * HARD-GATE shouldRespond policy instead of the participatory default. Only an
 * explicit `addressed_or_ambient` reply_gate opts a room's agent back into the
 * quiet-ambient bias; the unset default participates on its own judgment while
 * keeping ambient classification (ack suppression, provider exclusions, the
 * deliberate-silence terminal, and the engagement addressing gate) intact.
 */
export function isStage1AmbientHardGated(
	runtime: IAgentRuntime,
	message: Memory,
): boolean {
	try {
		return (
			resolveStage1ReplyGateMode(runtime, message) === "addressed_or_ambient"
		);
	} catch (error) {
		// error-policy:J7 personality lookup is advisory routing context. A store
		// failure must fail open to the participatory default, not force the
		// restrained gate.
		runtime.reportError("MessageService.resolveAmbientReplyGate", error, {
			roomId: message.roomId,
			entityId: message.entityId,
		});
		return false;
	}
}

export function isAmbientStage1Turn(
	runtime: IAgentRuntime,
	message: Memory,
	explicitlyAddressesAgent: boolean,
): boolean {
	let replyGateMode: ReplyGateMode | null;
	try {
		replyGateMode = resolveStage1ReplyGateMode(runtime, message);
	} catch (error) {
		// error-policy:J7 personality lookup is advisory routing context. A store
		// failure must fail open to the ordinary addressed prompt, not convert a
		// potentially explicit always-response turn into silence.
		runtime.reportError("MessageService.resolveAmbientReplyGate", error, {
			roomId: message.roomId,
			entityId: message.entityId,
		});
		return false;
	}
	if (replyGateMode === "always") return false;
	if (messageBypassesResponseEvaluation(runtime, message)) return false;
	return isUnaddressedTextGroupTurn(message, explicitlyAddressesAgent);
}

/**
 * Resolve the calling sender's role for context-catalog filtering.
 *
 * This is best-effort: when there is no world context, `checkSenderRole`
 * returns null and we fall through to the same source-aware floor that
 * `hasRoleAccess` uses. Owner-only messages always pass the agent's own
 * messages without a world lookup.
 */
export async function resolveStage1SenderRole(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<RoleGateRole> {
	if (
		typeof message.entityId === "string" &&
		message.entityId === runtime.agentId
	) {
		return "OWNER";
	}
	try {
		const result = await checkSenderRole(runtime, message);
		// The resolved role decides the entire action surface for the turn, and
		// a silent fall to the floor is indistinguishable from an explicit
		// non-elevated grant without this line. `result === null` means no world
		// resolved for the message — the most common cause of an owner probe
		// landing on the floor.
		runtime.logger.debug(
			{
				src: "service:message",
				entityId: message.entityId,
				roomId: message.roomId,
				worldResolved: result !== null,
				role: result?.role ?? null,
			},
			"Stage 1 sender role resolved",
		);
		if (result?.role) {
			return result.role as RoleGateRole;
		}
	} catch (error) {
		// error-policy:J4 Role resolution fails closed to the source-aware floor.
		runtime.logger.debug(
			{ src: "service:message", error },
			"Stage 1 sender role lookup failed; using unresolved role floor",
		);
		runtime.reportError("MessageService.resolveSenderRole", error, {
			entityId: message.entityId,
			roomId: message.roomId,
		});
	}
	return getUnresolvedSenderRoleFloor(message);
}

export function listAvailableContextsForRole(
	registry: ContextRegistry | undefined,
	role: RoleGateRole,
): ContextDefinition[] {
	if (!registry) {
		return [];
	}
	return registry.listAvailable(role);
}
