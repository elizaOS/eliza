/**
 * Tracks work intentionally moved past connector delivery so runtime shutdown,
 * tests, and latency telemetry can wait for real quiescence. Tasks remain
 * failure-observable through `runtime.reportError`; normal shutdown drains them
 * before services and the database disappear, while fast shutdown stays fast.
 */
import { ElizaError } from "../errors.ts";
import type { RoomHandlerLease } from "../runtime/room-handler-queue.ts";
import type { IAgentRuntime } from "../types/runtime.ts";

type TrackableRuntime = Pick<IAgentRuntime, "agentId" | "reportError"> &
	Partial<Pick<IAgentRuntime, "roomHandlerQueue">>;

export type PostDeliveryTaskKind = "room-state" | "diagnostic";

export type PostDeliveryTaskOptions =
	| {
			/** Diagnostic work never mutates state consumed by the next room turn. */
			kind: "diagnostic";
	  }
	| {
			/** Room-state work blocks the next turn until it settles. */
			kind: "room-state";
			roomId?: string;
			roomHandlerLease?: RoomHandlerLease;
	  };

const pendingByRuntime = new WeakMap<object, Set<Promise<void>>>();
const pendingByRuntimeRoom = new WeakMap<
	object,
	Map<string, Set<Promise<void>>>
>();

function pendingSet(runtime: TrackableRuntime): Set<Promise<void>> {
	const identity = runtime as object;
	let pending = pendingByRuntime.get(identity);
	if (!pending) {
		pending = new Set();
		pendingByRuntime.set(identity, pending);
	}
	return pending;
}

export function trackPostDeliveryTask(
	runtime: TrackableRuntime,
	label: string,
	task: () => Promise<unknown>,
	options: PostDeliveryTaskOptions = { kind: "room-state" },
): Promise<void> {
	const pending = pendingSet(runtime);
	const explicitRoomId =
		options.kind === "room-state" ? options.roomId : undefined;
	const explicitLease =
		options.kind === "room-state" ? options.roomHandlerLease : undefined;
	if ((explicitRoomId === undefined) !== (explicitLease === undefined)) {
		throw new ElizaError(
			"Room-state post-delivery ownership requires both room and lease",
			{
				code: "POST_DELIVERY_ROOM_OWNERSHIP_INVALID",
				context: { label, explicitRoomId },
			},
		);
	}
	if (
		explicitRoomId &&
		explicitLease &&
		!runtime.roomHandlerQueue?.ownsLease(explicitRoomId, explicitLease)
	) {
		throw new ElizaError(
			"Room-state post-delivery ownership capability is not live",
			{
				code: "POST_DELIVERY_ROOM_LEASE_MISMATCH",
				context: { label, roomId: explicitRoomId },
			},
		);
	}
	const roomId =
		options.kind === "room-state"
			? (explicitRoomId ?? runtime.roomHandlerQueue?.currentOwnership()?.roomId)
			: undefined;
	if (
		options.kind === "room-state" &&
		!roomId &&
		runtime.roomHandlerQueue?.requiresExplicitOwnership()
	) {
		throw new ElizaError(
			"Room-state post-delivery work requires explicit ownership in this runtime",
			{
				code: "POST_DELIVERY_ROOM_OWNERSHIP_REQUIRED",
				context: { label },
			},
		);
	}
	let roomPending: Set<Promise<void>> | undefined;
	if (roomId) {
		let rooms = pendingByRuntimeRoom.get(runtime as object);
		if (!rooms) {
			rooms = new Map();
			pendingByRuntimeRoom.set(runtime as object, rooms);
		}
		roomPending = rooms.get(roomId);
		if (!roomPending) {
			roomPending = new Set();
			rooms.set(roomId, roomPending);
		}
	}
	const promise = Promise.resolve()
		.then(task)
		.then(() => undefined)
		.catch((error) => {
			// error-policy:J1 The detached task boundary reports the real failure;
			// connector delivery has already succeeded and cannot be rolled back.
			runtime.reportError("PostDeliveryTask", error, {
				agentId: runtime.agentId,
				label,
			});
		})
		.finally(() => {
			pending.delete(promise);
			roomPending?.delete(promise);
			if (roomId && roomPending?.size === 0) {
				const rooms = pendingByRuntimeRoom.get(runtime as object);
				rooms?.delete(roomId);
				if (rooms?.size === 0) pendingByRuntimeRoom.delete(runtime as object);
			}
			if (pending.size === 0) {
				pendingByRuntime.delete(runtime as object);
			}
		});
	pending.add(promise);
	roomPending?.add(promise);
	return promise;
}

export function pendingPostDeliveryTaskCount(
	runtime: TrackableRuntime,
): number {
	return pendingByRuntime.get(runtime as object)?.size ?? 0;
}

export function pendingRoomPostDeliveryTaskCount(
	runtime: TrackableRuntime,
	roomId: string,
): number {
	return pendingByRuntimeRoom.get(runtime as object)?.get(roomId)?.size ?? 0;
}

export async function drainPostDeliveryTasks(
	runtime: TrackableRuntime,
): Promise<number> {
	let drained = 0;
	while (true) {
		const pending = pendingByRuntime.get(runtime as object);
		if (!pending || pending.size === 0) return drained;
		const batch = [...pending];
		drained += batch.length;
		await Promise.allSettled(batch);
	}
}

/** Drain every post-delivery task spawned under one live room owner. */
export async function drainRoomPostDeliveryTasks(
	runtime: TrackableRuntime,
	roomId: string,
): Promise<number> {
	let drained = 0;
	while (true) {
		const pending = pendingByRuntimeRoom.get(runtime as object)?.get(roomId);
		if (!pending || pending.size === 0) return drained;
		const batch = [...pending];
		drained += batch.length;
		await Promise.allSettled(batch);
	}
}
