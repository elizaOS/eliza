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

type TrackedPostDeliveryTask = {
	label: string;
	controller: AbortController;
	promise: Promise<void>;
};

type PostDeliveryTaskQuarantine = {
	reason: string;
};

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

const pendingByRuntime = new WeakMap<object, Set<TrackedPostDeliveryTask>>();
const pendingByRuntimeRoom = new WeakMap<
	object,
	Map<string, Set<TrackedPostDeliveryTask>>
>();
const quarantineByRuntime = new WeakMap<object, PostDeliveryTaskQuarantine>();

function pendingSet(runtime: TrackableRuntime): Set<TrackedPostDeliveryTask> {
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
	task: (signal: AbortSignal) => Promise<unknown>,
	options: PostDeliveryTaskOptions = { kind: "room-state" },
): Promise<void> {
	const quarantine = quarantineByRuntime.get(runtime as object);
	if (quarantine) {
		throw new ElizaError(
			"Post-delivery work cannot start on a quarantined runtime",
			{
				code: "POST_DELIVERY_RUNTIME_QUARANTINED",
				context: { label, quarantineReason: quarantine.reason },
			},
		);
	}
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
	let roomPending: Set<TrackedPostDeliveryTask> | undefined;
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
	const controller = new AbortController();
	let tracked!: TrackedPostDeliveryTask;
	const promise = Promise.resolve()
		.then(() => {
			if (controller.signal.aborted) throw controller.signal.reason;
			return task(controller.signal);
		})
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
			pending.delete(tracked);
			roomPending?.delete(tracked);
			if (roomId && roomPending?.size === 0) {
				const rooms = pendingByRuntimeRoom.get(runtime as object);
				rooms?.delete(roomId);
				if (rooms?.size === 0) pendingByRuntimeRoom.delete(runtime as object);
			}
			if (pending.size === 0) {
				pendingByRuntime.delete(runtime as object);
			}
		});
	tracked = { label, controller, promise };
	pending.add(tracked);
	roomPending?.add(tracked);
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
	options: { signal?: AbortSignal } = {},
): Promise<number> {
	const quarantine = quarantineByRuntime.get(runtime as object);
	if (quarantine) {
		throw quarantinedDrainError(runtime, quarantine.reason);
	}
	let drained = 0;
	while (true) {
		const pending = pendingByRuntime.get(runtime as object);
		if (!pending || pending.size === 0) return drained;
		if (options.signal?.aborted) {
			throw quarantinePostDeliveryTasks(runtime, options.signal.reason);
		}
		const batch = [...pending];
		drained += batch.length;
		const settled = Promise.allSettled(batch.map((entry) => entry.promise));
		if (!options.signal) {
			await settled;
			continue;
		}
		await new Promise<void>((resolve, reject) => {
			const abort = () =>
				reject(quarantinePostDeliveryTasks(runtime, options.signal?.reason));
			options.signal?.addEventListener("abort", abort, { once: true });
			settled.then(
				() => {
					options.signal?.removeEventListener("abort", abort);
					resolve();
				},
				(error) => {
					options.signal?.removeEventListener("abort", abort);
					reject(error);
				},
			);
		});
	}
}

/**
 * Permanently refuse runtime reuse and request cooperative cancellation.
 * JavaScript cannot terminate work that ignores its signal, so pending entries
 * remain visible until they really settle; callers must isolate or end the
 * containing process/generation after quarantine.
 */
export function quarantinePostDeliveryTasks(
	runtime: TrackableRuntime,
	reason: unknown,
): ElizaError {
	const identity = runtime as object;
	const requestedDetail =
		reason instanceof Error
			? reason.message.trim()
			: typeof reason === "string"
				? reason.trim()
				: "";
	const quarantine =
		quarantineByRuntime.get(identity) ??
		({
			reason: requestedDetail || "post-delivery drain was cancelled",
		} satisfies PostDeliveryTaskQuarantine);
	quarantineByRuntime.set(identity, quarantine);
	const pending = pendingByRuntime.get(identity);
	for (const entry of pending ?? []) {
		if (!entry.controller.signal.aborted) {
			entry.controller.abort(new Error(quarantine.reason));
		}
	}
	return quarantinedDrainError(runtime, quarantine.reason);
}

function quarantinedDrainError(
	runtime: TrackableRuntime,
	reason: string,
): ElizaError {
	const pending = pendingByRuntime.get(runtime as object);
	return new ElizaError(
		"Post-delivery tasks did not reach quiescence; runtime quarantined",
		{
			code: "POST_DELIVERY_DRAIN_CANCELLED",
			context: {
				reason,
				pendingLabels: [...(pending ?? [])].map((entry) => entry.label),
			},
		},
	);
}

export function postDeliveryTaskQuarantineReason(
	runtime: TrackableRuntime,
): string | undefined {
	return quarantineByRuntime.get(runtime as object)?.reason;
}

/** Drain every post-delivery task spawned under one live room owner. */
export async function drainRoomPostDeliveryTasks(
	runtime: TrackableRuntime,
	roomId: string,
): Promise<number> {
	const quarantine = quarantineByRuntime.get(runtime as object);
	if (quarantine) {
		throw quarantinedDrainError(runtime, quarantine.reason);
	}
	let drained = 0;
	while (true) {
		const pending = pendingByRuntimeRoom.get(runtime as object)?.get(roomId);
		if (!pending || pending.size === 0) return drained;
		const batch = [...pending];
		drained += batch.length;
		await Promise.allSettled(batch.map((entry) => entry.promise));
	}
}
