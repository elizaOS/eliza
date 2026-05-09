import {
	findKeywordTermMatch,
	getValidationKeywordTerms,
} from "../../../i18n/validation-keywords.ts";
import { logger } from "../../../logger.ts";
import {
	shouldFollowRoomTemplate,
	shouldMuteRoomTemplate,
	shouldUnfollowRoomTemplate,
	shouldUnmuteRoomTemplate,
} from "../../../prompts.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import { ModelType } from "../../../types/index.ts";
import {
	composePromptFromState,
	parseBooleanFromText,
} from "../../../utils.ts";

/**
 * ROOM_OP — unified room subscription / chat-thread state action.
 *
 * Replaces MUTE_ROOM / UNMUTE_ROOM / FOLLOW_ROOM / UNFOLLOW_ROOM (core) and
 * the connector-targeted CHAT_THREAD action (app-lifeops). Defaults to the
 * current room when `roomId` / `chatName` are omitted; supports cross-room
 * targeting by `platform` + `chatName` lookup, and an optional
 * `durationMinutes` mute window that surfaces a scheduling hint for the
 * connector layer (auto-unmute scheduling lives in app-lifeops'
 * scheduled-trigger-task plumbing — core does not import outer plugins).
 */

const ROOM_OPS = ["follow", "unfollow", "mute", "unmute"] as const;
type RoomOp = (typeof ROOM_OPS)[number];

const ROOM_CONTEXTS = ["messaging", "contacts", "settings"] as const;

type ParticipantState = "FOLLOWED" | "MUTED" | null;

type RoomOpParams = {
	op?: RoomOp | string;
	roomId?: string;
	platform?: string;
	chatName?: string;
	durationMinutes?: number;
};

type RuntimeLike = IAgentRuntime & {
	getRoomsForParticipant?: (entityId: UUID) => Promise<UUID[]>;
};

type OpConfig = {
	template: string;
	nextState: ParticipantState;
	startedAction: string;
	startAction: string;
	failedAction: string;
	startedThought: string;
	transitionThought: (roomName: string) => string;
	declinedThought: string;
	successText: (roomName: string) => string;
	declinedText: (roomName: string) => string;
	resultKey: "roomFollowed" | "roomUnfollowed" | "roomMuted" | "roomUnmuted";
	dataKey: "followed" | "unfollowed" | "muted" | "unmuted";
};

const OPS: Record<RoomOp, OpConfig> = {
	follow: {
		template: shouldFollowRoomTemplate,
		nextState: "FOLLOWED",
		startedAction: "ROOM_FOLLOW_STARTED",
		startAction: "ROOM_FOLLOW_START",
		failedAction: "ROOM_FOLLOW_FAILED",
		startedThought: "I will now follow this room and chime in",
		transitionThought: (n) => `I followed the room ${n}`,
		declinedThought: "I decided to not follow this room",
		successText: (n) => `Now following room: ${n}`,
		declinedText: (n) => `Decided not to follow room: ${n}`,
		resultKey: "roomFollowed",
		dataKey: "followed",
	},
	unfollow: {
		template: shouldUnfollowRoomTemplate,
		nextState: null,
		startedAction: "ROOM_UNFOLLOW_STARTED",
		startAction: "ROOM_UNFOLLOW_START",
		failedAction: "ROOM_UNFOLLOW_FAILED",
		startedThought: "I will now unfollow this room",
		transitionThought: (n) => `I unfollowed the room ${n}`,
		declinedThought: "I decided to not unfollow this room",
		successText: (n) => `Stopped following room: ${n}`,
		declinedText: (n) => `Decided not to unfollow room: ${n}`,
		resultKey: "roomUnfollowed",
		dataKey: "unfollowed",
	},
	mute: {
		template: shouldMuteRoomTemplate,
		nextState: "MUTED",
		startedAction: "ROOM_MUTE_STARTED",
		startAction: "ROOM_MUTE_START",
		failedAction: "ROOM_MUTE_FAILED",
		startedThought: "I will now mute this room",
		transitionThought: (n) => `I muted the room ${n}`,
		declinedThought: "I decided to not mute this room",
		successText: (n) => `Room muted: ${n}`,
		declinedText: (n) => `Decided not to mute room: ${n}`,
		resultKey: "roomMuted",
		dataKey: "muted",
	},
	unmute: {
		template: shouldUnmuteRoomTemplate,
		nextState: null,
		startedAction: "ROOM_UNMUTE_STARTED",
		startAction: "ROOM_UNMUTE_START",
		failedAction: "ROOM_UNMUTE_FAILED",
		startedThought:
			"I will now unmute this room and start considering it for responses again",
		transitionThought: (n) => `I unmuted the room ${n}`,
		declinedThought: "I decided to not unmute this room",
		successText: (n) => `Room unmuted: ${n}`,
		declinedText: (n) => `Decided not to unmute room: ${n}`,
		resultKey: "roomUnmuted",
		dataKey: "unmuted",
	},
};

const MUTE_TERMS = getValidationKeywordTerms("action.muteRoom.request", {
	includeAllLocales: true,
});
const UNMUTE_TERMS = getValidationKeywordTerms("action.unmuteRoom.request", {
	includeAllLocales: true,
});
const FOLLOW_TERMS = getValidationKeywordTerms("action.followRoom.request", {
	includeAllLocales: true,
});

function normalizeOp(value: unknown): RoomOp | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === "mute" || normalized === "mute_chat") return "mute";
	if (
		normalized === "unmute" ||
		normalized === "unmute_chat" ||
		normalized === "restore_chat"
	) {
		return "unmute";
	}
	if (normalized === "follow") return "follow";
	if (normalized === "unfollow") return "unfollow";
	return null;
}

function normalizeString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePlatform(value: unknown): string | undefined {
	const trimmed = normalizeString(value);
	return trimmed ? trimmed.toLowerCase() : undefined;
}

function normalizeDurationMinutes(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
	}
	return undefined;
}

function getMessageText(message: Memory): string {
	if (typeof message?.content === "string") return message.content;
	return message?.content?.text ?? "";
}

function inferOpFromText(text: string): RoomOp | null {
	if (findKeywordTermMatch(text, UNMUTE_TERMS) !== undefined) return "unmute";
	if (findKeywordTermMatch(text, MUTE_TERMS) !== undefined) return "mute";
	if (findKeywordTermMatch(text, FOLLOW_TERMS) !== undefined) return "follow";
	return null;
}

function preconditionMet(op: RoomOp, current: ParticipantState): boolean {
	switch (op) {
		case "follow":
			return current !== "FOLLOWED" && current !== "MUTED";
		case "unfollow":
			return current === "FOLLOWED";
		case "mute":
			return current !== "MUTED";
		case "unmute":
			return current === "MUTED";
	}
}

function readRoomOpParams(options?: HandlerOptions): RoomOpParams {
	return ((options as { parameters?: RoomOpParams } | undefined)?.parameters ??
		{}) as RoomOpParams;
}

function roomPreconditionFailureResult(args: {
	op: RoomOp;
	current: ParticipantState;
	roomId?: UUID;
}): ActionResult {
	return {
		success: false,
		text: `Cannot ${args.op} room from state ${args.current ?? "NONE"}`,
		values: {
			success: false,
			error: `ROOM_${args.op.toUpperCase()}_PRECONDITION_FAILED`,
		},
		data: {
			actionName: "ROOM",
			op: args.op,
			...(args.roomId ? { roomId: args.roomId } : {}),
			error: `ROOM_${args.op.toUpperCase()}_PRECONDITION_FAILED`,
			currentState: args.current ?? "NONE",
		},
	};
}

async function validateRoomOpAvailability(
	runtime: IAgentRuntime,
	message: Memory,
	_state?: State,
	options?: HandlerOptions,
	forcedOp?: RoomOp,
): Promise<boolean> {
	if (typeof runtime.getParticipantUserState !== "function") {
		return false;
	}

	const params = readRoomOpParams(options);
	const op = forcedOp ?? normalizeOp(params.op);
	if (!op) {
		return true;
	}

	const platform = normalizePlatform(params.platform);
	const explicitRoomId = normalizeString(params.roomId);
	const chatName = normalizeString(params.chatName);
	let roomId = explicitRoomId as UUID | undefined;

	if (platform && (explicitRoomId || chatName)) {
		const targetRoom = await resolveTargetRoom({
			runtime: runtime as RuntimeLike,
			platform,
			roomId: explicitRoomId,
			chatName,
		});
		if (!targetRoom) {
			return false;
		}
		roomId = targetRoom.id;
	}

	roomId = (roomId ?? message.roomId) as UUID;
	const current = (await runtime.getParticipantUserState(
		roomId,
		runtime.agentId,
	)) as ParticipantState;
	return preconditionMet(op, current);
}

async function decide(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
	cfg: OpConfig,
	op: RoomOp,
): Promise<boolean> {
	const prompt = composePromptFromState({ state, template: cfg.template });
	const response = await runtime.useModel(ModelType.TEXT_SMALL, {
		prompt,
		stopSequences: [],
	});
	const cleaned = response.trim().toLowerCase();
	const yes =
		parseBooleanFromText(response.trim()) ||
		cleaned.includes("true") ||
		cleaned.includes("yes");

	if (yes) {
		await runtime.createMemory(
			{
				entityId: message.entityId,
				agentId: message.agentId,
				roomId: message.roomId,
				content: {
					source: message.content.source,
					thought: cfg.startedThought,
					actions: [cfg.startedAction],
				},
			},
			"messages",
		);
		return true;
	}

	const no =
		cleaned === "false" ||
		cleaned === "no" ||
		cleaned === "n" ||
		cleaned.includes("false") ||
		cleaned.includes("no");

	if (no) {
		await runtime.createMemory(
			{
				entityId: message.entityId,
				agentId: message.agentId,
				roomId: message.roomId,
				content: {
					source: message.content.source,
					thought: cfg.declinedThought,
					actions: [cfg.failedAction],
				},
			},
			"messages",
		);
		return false;
	}

	logger.warn(
		{
			src: `plugin:advanced-capabilities:action:room_op:${op}`,
			agentId: runtime.agentId,
			response,
		},
		"Unclear boolean response, defaulting to false",
	);
	return false;
}

function roomMatchesTarget(args: {
	room: Awaited<ReturnType<IAgentRuntime["getRoom"]>>;
	platform: string;
	roomId?: string;
	chatName?: string;
}): boolean {
	const room = args.room;
	if (!room) return false;
	if (
		normalizePlatform((room as { source?: unknown }).source) !== args.platform
	) {
		return false;
	}
	if (args.roomId && room.id === args.roomId) return true;
	if (!args.chatName) return false;
	const lookup = args.chatName.trim().toLowerCase();
	const candidates = [
		typeof room.name === "string" ? room.name : "",
		typeof room.channelId === "string" ? room.channelId : "",
		typeof room.id === "string" ? room.id : "",
	]
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);
	return candidates.some(
		(candidate) => candidate === lookup || candidate.includes(lookup),
	);
}

async function resolveTargetRoom(args: {
	runtime: RuntimeLike;
	platform: string;
	roomId?: string;
	chatName?: string;
}): Promise<Awaited<ReturnType<IAgentRuntime["getRoom"]>> | null> {
	if (args.roomId) {
		return await args.runtime.getRoom(args.roomId as UUID);
	}
	const roomIds =
		(await args.runtime.getRoomsForParticipant?.(args.runtime.agentId)) ?? [];
	for (const roomId of roomIds) {
		const room = await args.runtime.getRoom(roomId);
		if (
			roomMatchesTarget({
				room,
				platform: args.platform,
				chatName: args.chatName,
			})
		) {
			return room;
		}
	}
	return null;
}

async function applyOp(args: {
	runtime: IAgentRuntime;
	message: Memory;
	op: RoomOp;
	roomId: UUID;
	roomName: string;
	cfg: OpConfig;
}): Promise<ActionResult> {
	try {
		await args.runtime.updateParticipantUserState(
			args.roomId,
			args.runtime.agentId,
			args.cfg.nextState,
		);
		await args.runtime.createMemory(
			{
				entityId: args.message.entityId,
				agentId: args.message.agentId,
				roomId: args.message.roomId,
				content: {
					thought: args.cfg.transitionThought(args.roomName),
					actions: [args.cfg.startAction],
				},
			},
			"messages",
		);
		return {
			text: args.cfg.successText(args.roomName),
			values: {
				success: true,
				[args.cfg.resultKey]: true,
				roomId: args.roomId,
				roomName: args.roomName,
				newState: args.cfg.nextState ?? "NONE",
			},
			data: {
				actionName: "ROOM",
				op: args.op,
				roomId: args.roomId,
				roomName: args.roomName,
				[args.cfg.dataKey]: true,
			},
			success: true,
		};
	} catch (error) {
		logger.error(
			{
				src: `plugin:advanced-capabilities:action:room_op:${args.op}`,
				agentId: args.runtime.agentId,
				error: error instanceof Error ? error.message : String(error),
			},
			`Error applying ROOM_OP ${args.op}`,
		);
		return {
			text: `Failed to ${args.op} room`,
			values: {
				success: false,
				error: `ROOM_${args.op.toUpperCase()}_FAILED`,
			},
			data: {
				actionName: "ROOM",
				op: args.op,
				roomId: args.roomId,
				error: error instanceof Error ? error.message : String(error),
			},
			success: false,
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
}

export const roomOpAction: Action = {
	name: "ROOM",
	contexts: [...ROOM_CONTEXTS],
	roleGate: { minRole: "ADMIN" },
	similes: [
		"MUTE_ROOM",
		"UNMUTE_ROOM",
		"FOLLOW_ROOM",
		"UNFOLLOW_ROOM",
		"MUTE_CHAT",
		"UNMUTE_CHAT",
		"MUTE_TELEGRAM",
		"MUTE_DISCORD",
		"SILENCE_GROUP_CHAT",
		"FOLLOW_CHAT",
		"FOLLOW_CHANNEL",
		"FOLLOW_THREAD",
		"UNFOLLOW_CHAT",
		"UNFOLLOW_THREAD",
		"JOIN_ROOM",
		"LEAVE_ROOM",
		"CHAT_THREAD",
		"ROOM",
	],
	description:
		"Mute, unmute, follow, or unfollow a room. Defaults to the current room; targets a specific connector chat when `platform` and `chatName` (or `roomId`) are supplied. `op: mute` with `durationMinutes` returns a scheduling hint for an automatic unmute.",
	descriptionCompressed:
		"room subscription state: op=mute|unmute|follow|unfollow + optional roomId|platform+chatName + durationMinutes (mute auto-unmute hint)",
	parameters: [
		{
			name: "op",
			description:
				"Operation: mute | unmute | follow | unfollow. Inferred from message text when omitted.",
			required: false,
			schema: {
				type: "string" as const,
				enum: [...ROOM_OPS],
			},
		},
		{
			name: "roomId",
			description:
				"Target room id. Defaults to the current message's room when omitted.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "platform",
			description:
				"Connector id (telegram, discord, ...) for cross-room targeting via chatName.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "chatName",
			description:
				"Channel/group title to look up when targeting a room other than the current one.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "durationMinutes",
			description:
				"For op=mute: temporary mute window. Returns a scheduleAutoUnmuteIso hint.",
			required: false,
			schema: { type: "number" as const },
		},
	],
	examples: [
		[
			{
				name: "{{name1}}",
				content: { text: "{{name2}}, please mute this channel." },
			},
			{
				name: "{{agentName}}",
				content: { text: "Got it, muting.", actions: ["ROOM"] },
			},
		],
		[
			{
				name: "{{name1}}",
				content: { text: "{{name2}} unmute this room please" },
			},
			{
				name: "{{agentName}}",
				content: { text: "Unmuted.", actions: ["ROOM"] },
			},
		],
		[
			{
				name: "{{name1}}",
				content: { text: "hey {{name2}} follow this channel" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Sure, I will now follow this room.",
					actions: ["ROOM"],
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: { text: "{{name2}} stop following this channel" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Okay, I'll stop following this room.",
					actions: ["ROOM"],
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "Mute the crypto signals Telegram channel for six hours.",
				},
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Muted crypto signals on Telegram for 360 minutes.",
					actions: ["ROOM"],
				},
			},
		],
	] as ActionExample[][],
	validate: validateRoomOpAvailability,
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
		_callback?: HandlerCallback,
		_responses?: Memory[],
	): Promise<ActionResult> => {
		const params = readRoomOpParams(options);

		const op =
			normalizeOp(params.op) ?? inferOpFromText(getMessageText(message));
		if (!op) {
			return {
				text: "Specify op: mute, unmute, follow, or unfollow.",
				values: { success: false, error: "ROOM_OP_REQUIRED" },
				data: { actionName: "ROOM", error: "ROOM_OP_REQUIRED" },
				success: false,
			};
		}

		const cfg = OPS[op];
		const platform = normalizePlatform(params.platform);
		const explicitRoomId = normalizeString(params.roomId);
		const chatName = normalizeString(params.chatName);
		const durationMinutes = normalizeDurationMinutes(params.durationMinutes);

		// Connector-targeted path (replaces CHAT_THREAD).
		// Skip the model gate and act directly on the named room; preserves
		// the previous CHAT_THREAD shape.
		if (platform && (explicitRoomId || chatName)) {
			const targetRoom = await resolveTargetRoom({
				runtime: runtime as RuntimeLike,
				platform,
				roomId: explicitRoomId,
				chatName,
			});
			if (!targetRoom) {
				return {
					text: `I couldn't find that ${platform} chat yet.`,
					values: { success: false, error: "ROOM_NOT_FOUND" },
					data: {
						actionName: "ROOM",
						op,
						platform,
						roomId: explicitRoomId ?? null,
						chatName: chatName ?? null,
						error: "ROOM_NOT_FOUND",
					},
					success: false,
				};
			}
			const current = (await runtime.getParticipantUserState(
				targetRoom.id,
				runtime.agentId,
			)) as ParticipantState;
			if (!preconditionMet(op, current)) {
				return roomPreconditionFailureResult({
					op,
					current,
					roomId: targetRoom.id,
				});
			}
			const roomName =
				targetRoom.name ??
				chatName ??
				`Room-${String(targetRoom.id).substring(0, 8)}`;
			const result = await applyOp({
				runtime,
				message,
				op,
				roomId: targetRoom.id,
				roomName,
				cfg,
			});
			if (
				op === "mute" &&
				result.success &&
				durationMinutes &&
				durationMinutes > 0 &&
				typeof result.data === "object" &&
				result.data !== null
			) {
				return {
					...result,
					text: `Muted ${roomName} on ${platform} for ${durationMinutes} minutes.`,
					data: {
						...result.data,
						platform,
						durationMinutes,
						scheduleAutoUnmuteIso: new Date(
							Date.now() + durationMinutes * 60_000,
						).toISOString(),
					},
				};
			}
			return result;
		}

		// Default path: operate on the current room with model-decision gating
		// (matches previous MUTE_ROOM / UNMUTE_ROOM / FOLLOW_ROOM / UNFOLLOW_ROOM
		// behavior).
		if (!state) {
			return {
				text: "State is required for ROOM",
				values: {
					success: false,
					error: `ROOM_${op.toUpperCase()}_FAILED`,
				},
				data: {
					actionName: "ROOM",
					op,
					error: "STATE_REQUIRED",
				},
				success: false,
				error: new Error("State is required for ROOM"),
			};
		}

		const roomId = (explicitRoomId ?? message.roomId) as UUID;
		const current = (await runtime.getParticipantUserState(
			roomId,
			runtime.agentId,
		)) as ParticipantState;

			if (!preconditionMet(op, current)) {
				return roomPreconditionFailureResult({ op, current, roomId });
			}

		const proceed = await decide(runtime, message, state, cfg, op);
		const room =
			(state.data.room as { name?: string } | undefined) ??
			(await runtime.getRoom(roomId));

		if (!room) {
			return {
				text: `Could not find room to ${op}`,
				values: { success: false, error: "ROOM_NOT_FOUND" },
				data: { actionName: "ROOM", op, error: "ROOM_NOT_FOUND" },
				success: false,
			};
		}

		const roomName = room.name ?? `Room-${String(roomId).substring(0, 8)}`;

		if (!proceed) {
			return {
				text: cfg.declinedText(roomName),
				values: {
					success: true,
					[cfg.resultKey]: false,
					roomId,
					roomName,
					reason: "NOT_APPROPRIATE",
				},
				data: {
					actionName: "ROOM",
					op,
					roomId,
					roomName,
					[cfg.dataKey]: false,
					reason: "Decision criteria not met",
				},
				success: true,
			};
		}

		return await applyOp({
			runtime,
			message,
			op,
			roomId,
			roomName,
			cfg,
		});
	},
};

function makeRoomOpChildAction(args: {
	name: string;
	op: RoomOp;
	description: string;
	descriptionCompressed: string;
	similes: string[];
}): Action {
	return {
		name: args.name,
		contexts: [...ROOM_CONTEXTS],
		roleGate: { minRole: "ADMIN" },
		similes: args.similes,
		description: args.description,
		descriptionCompressed: args.descriptionCompressed,
		parameters: roomOpAction.parameters?.filter(
			(parameter) => parameter.name !== "op",
		),
		validate: (runtime, message, state, options) =>
			validateRoomOpAvailability(
				runtime,
				message,
				state,
				options as HandlerOptions | undefined,
				args.op,
			),
		handler: (runtime, message, state, options, callback, responses) => {
			const params =
				options?.parameters && typeof options.parameters === "object"
					? (options.parameters as Record<string, unknown>)
					: {};
			return roomOpAction.handler(
				runtime,
				message,
				state,
				{
					...(options ?? {}),
					parameters: {
						...params,
						op: args.op,
					},
				},
				callback,
				responses,
			);
		},
	};
}

export const muteRoomAction = makeRoomOpChildAction({
	name: "MUTE_ROOM",
	op: "mute",
	description:
		"Mute a room or connector chat when the agent is not already muted there.",
	descriptionCompressed:
		"mute room/chat if current participant state is not MUTED; optional roomId|platform+chatName|durationMinutes",
	similes: ["MUTE_CHAT", "SILENCE_GROUP_CHAT", "MUTE_CHANNEL"],
});

export const unmuteRoomAction = makeRoomOpChildAction({
	name: "UNMUTE_ROOM",
	op: "unmute",
	description:
		"Unmute a room or connector chat only when the agent is currently muted there.",
	descriptionCompressed:
		"unmute room/chat only from MUTED participant state; optional roomId|platform+chatName",
	similes: ["UNMUTE_CHAT", "RESTORE_CHAT", "UNMUTE_CHANNEL"],
});

export const followRoomAction = makeRoomOpChildAction({
	name: "FOLLOW_ROOM",
	op: "follow",
	description:
		"Follow a room or connector chat when the agent is not already following or muted there.",
	descriptionCompressed:
		"follow room/chat if state is neither FOLLOWED nor MUTED; optional roomId|platform+chatName",
	similes: ["FOLLOW_CHAT", "FOLLOW_CHANNEL", "JOIN_ROOM"],
});

export const unfollowRoomAction = makeRoomOpChildAction({
	name: "UNFOLLOW_ROOM",
	op: "unfollow",
	description:
		"Unfollow a room or connector chat only when the agent is currently following there.",
	descriptionCompressed:
		"unfollow room/chat only from FOLLOWED participant state; optional roomId|platform+chatName",
	similes: ["UNFOLLOW_CHAT", "UNFOLLOW_THREAD", "LEAVE_ROOM"],
});

roomOpAction.subActions = [
	muteRoomAction,
	unmuteRoomAction,
	followRoomAction,
	unfollowRoomAction,
];
