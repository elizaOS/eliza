/**
 * Effective mute resolution for inbound message gating. The per-room store is
 * the participant `room_state` ("MUTED") the ROOM action already writes; this
 * module layers the two pieces that make it enforceable: a server-wide mute
 * kept on `world.metadata` (`agentMuteState`, so one op silences every channel
 * of a guild without a parallel store) and the timed-mute due-check
 * (`agentMuteUntilIso` on room/world metadata) that auto-unmutes on the first
 * inbound message at/after the ISO time — the structural consumer of the ROOM
 * action's `scheduleAutoUnmuteIso` contract.
 *
 * One resolver = one truth for "is the agent muted here". Consulted by core
 * `processMessage` (drops muted turns before the planner, independent of the
 * mention path — a muted room drops even a direct @mention, because on
 * mention-gated deployments every planner-reaching turn IS a mention),
 * connector inbound paths (plugin-discord drops before ingestion), and the
 * MESSAGE list ops (muted flags in list_channels / list_connections).
 */
import { createUniqueUuid } from "../../entities.ts";
import type { Room, World } from "../../types/environment.ts";
import type { UUID } from "../../types/primitives.ts";
import type {
	IAgentRuntime,
	MessageConnectorTarget,
} from "../../types/runtime.ts";

type ParticipantUserState = "FOLLOWED" | "MUTED" | null;

export type EffectiveMuteState =
	| { muted: false }
	| { muted: true; scope: "room"; roomId: UUID }
	| { muted: true; scope: "server"; worldId: UUID };

function readMuteUntilIso(
	metadata: Record<string, unknown> | undefined,
): string | undefined {
	const value = metadata?.agentMuteUntilIso;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** True when a timed mute carries an ISO expiry that has already passed. */
export function muteExpiryDue(
	untilIso: string | undefined,
	now: number,
): boolean {
	if (!untilIso) return false;
	const expiry = Date.parse(untilIso);
	return Number.isFinite(expiry) && expiry <= now;
}

/** Read-only: is this world under an active (non-expired) server-wide mute? */
export function worldMuteActive(
	world: World | null | undefined,
	now: number = Date.now(),
): boolean {
	const metadata = world?.metadata;
	if (metadata?.agentMuteState !== "MUTED") return false;
	return !muteExpiryDue(readMuteUntilIso(metadata), now);
}

/** Read-only: is this room under an active (non-expired) participant mute? */
export function roomMuteActive(
	participantState: ParticipantUserState,
	room: Room | null | undefined,
	now: number = Date.now(),
): boolean {
	if (participantState !== "MUTED") return false;
	return !muteExpiryDue(
		readMuteUntilIso(room?.metadata as Record<string, unknown> | undefined),
		now,
	);
}

/**
 * Resolve whether the agent is muted for an inbound message, applying the
 * timed-mute due-check as a side effect: a room or world whose
 * `agentMuteUntilIso` has passed is unmuted in place (participant state /
 * world metadata cleared) and no longer drops the turn.
 *
 * `roomIds` is the message's room first, then any ancestor rooms that should
 * inherit the mute (e.g. a Discord thread's parent channel). `worldId` may be
 * passed when the caller already knows it (connectors derive it without a DB
 * read); otherwise it is read from the first room record. Likewise
 * `primaryParticipantState` lets a caller that already fetched the first
 * room's participant state skip the refetch — the message pipeline reads it
 * for its LLM-off check just before this resolver runs.
 */
export async function resolveEffectiveMuteState(
	runtime: IAgentRuntime,
	args: {
		roomIds: readonly UUID[];
		worldId?: UUID;
		primaryParticipantState?: ParticipantUserState;
	},
	now: number = Date.now(),
): Promise<EffectiveMuteState> {
	let worldId = args.worldId;
	let primaryRoom: Room | null | undefined;

	for (const roomId of args.roomIds) {
		const state =
			roomId === args.roomIds[0] && args.primaryParticipantState !== undefined
				? args.primaryParticipantState
				: await runtime.getParticipantUserState(roomId, runtime.agentId);
		if (state !== "MUTED") continue;
		const room = await runtime.getRoom(roomId);
		if (roomId === args.roomIds[0]) primaryRoom = room;
		const untilIso = readMuteUntilIso(
			room?.metadata as Record<string, unknown> | undefined,
		);
		if (!muteExpiryDue(untilIso, now)) {
			return { muted: true, scope: "room", roomId };
		}
		// Timed mute reached its ISO expiry — auto-unmute and keep processing.
		await runtime.updateParticipantUserState(roomId, runtime.agentId, null);
		if (room?.metadata && "agentMuteUntilIso" in room.metadata) {
			const { agentMuteUntilIso: _expired, ...rest } = room.metadata;
			await runtime.updateRoom({ ...room, metadata: rest });
		}
	}

	if (!worldId) {
		if (primaryRoom === undefined) {
			primaryRoom = await runtime.getRoom(args.roomIds[0]);
		}
		worldId = primaryRoom?.worldId;
	}
	if (!worldId) return { muted: false };

	const world = await runtime.getWorld(worldId);
	if (world?.metadata?.agentMuteState !== "MUTED") {
		return { muted: false };
	}
	if (muteExpiryDue(readMuteUntilIso(world.metadata), now)) {
		const {
			agentMuteState: _state,
			agentMuteUntilIso: _until,
			...rest
		} = world.metadata;
		await runtime.updateWorld({ ...world, metadata: rest });
		return { muted: false };
	}
	return { muted: true, scope: "server", worldId };
}

/**
 * Write or clear the server-wide mute on a world. Passing `null` unmutes.
 * Returns the updated world, or null when the world does not exist.
 */
export async function setWorldMuteState(
	runtime: IAgentRuntime,
	worldId: UUID,
	mute: { untilIso?: string } | null,
): Promise<World | null> {
	const world = await runtime.getWorld(worldId);
	if (!world) return null;
	const {
		agentMuteState: _state,
		agentMuteUntilIso: _until,
		...rest
	} = world.metadata ?? {};
	const updated: World = {
		...world,
		metadata: mute
			? {
					...rest,
					agentMuteState: "MUTED" as const,
					...(mute.untilIso ? { agentMuteUntilIso: mute.untilIso } : {}),
				}
			: rest,
	};
	await runtime.updateWorld(updated);
	return updated;
}

/**
 * Write or clear the timed-mute expiry on a room. Passing `null` clears any
 * stale expiry (an untimed mute must not inherit a previous timed one).
 * Throws when an expiry is requested for a room that does not exist — a
 * silently-unstored expiry would make the timed mute permanent again.
 */
export async function setRoomMuteUntil(
	runtime: IAgentRuntime,
	roomId: UUID,
	untilIso: string | null,
): Promise<void> {
	const room = await runtime.getRoom(roomId);
	if (!room) {
		if (untilIso === null) return;
		throw new Error(`Cannot store mute expiry: room ${roomId} not found`);
	}
	if (untilIso === null) {
		if (!room.metadata || !("agentMuteUntilIso" in room.metadata)) return;
		const { agentMuteUntilIso: _cleared, ...rest } = room.metadata;
		await runtime.updateRoom({ ...room, metadata: rest });
		return;
	}
	await runtime.updateRoom({
		...room,
		metadata: { ...(room.metadata ?? {}), agentMuteUntilIso: untilIso },
	});
}

/**
 * Per-target muted flags for connector room listings (list_channels /
 * list_connections). Read-only — the inbound due-check owns expiry writes, so
 * an expired timed mute simply reports unmuted here. Targets map to rooms via
 * their explicit roomId or the canonical `createUniqueUuid(runtime, channelId)`
 * convention every connector uses for inbound messages; unknown mappings
 * report unmuted.
 */
export async function resolveMutedTargetFlags(
	runtime: IAgentRuntime,
	targets: readonly MessageConnectorTarget[],
	now: number = Date.now(),
): Promise<boolean[]> {
	const worldMuteCache = new Map<string, boolean>();
	const isServerMuted = async (serverId: string): Promise<boolean> => {
		const cached = worldMuteCache.get(serverId);
		if (cached !== undefined) return cached;
		const world = await runtime.getWorld(createUniqueUuid(runtime, serverId));
		const active = worldMuteActive(world, now);
		worldMuteCache.set(serverId, active);
		return active;
	};

	return Promise.all(
		targets.map(async (entry) => {
			const roomId =
				entry.target.roomId ??
				(entry.target.channelId
					? createUniqueUuid(runtime, entry.target.channelId)
					: undefined);
			if (roomId) {
				const state = await runtime.getParticipantUserState(
					roomId,
					runtime.agentId,
				);
				if (state === "MUTED") {
					const room = await runtime.getRoom(roomId);
					if (roomMuteActive(state, room, now)) return true;
				}
			}
			return entry.target.serverId
				? isServerMuted(entry.target.serverId)
				: false;
		}),
	);
}
