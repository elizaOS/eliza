/**
 * Serializes handler work per room while allowing unrelated rooms to proceed.
 * Every item runs independently in arrival order; intent coalescing remains a
 * planner concern. Waiting transports may cancel before acquisition, while an
 * acquired lease remains owned until its complete durable outcome settles.
 */

import { ElizaError } from "../errors";

interface QueuedItem<T> {
	fn: () => Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
	enqueuedAt: number;
	onAbort?: () => void;
	signal?: AbortSignal;
}

export class RoomHandlerQueueAbortedError extends Error {
	readonly roomId: string;

	constructor(roomId: string, options?: ErrorOptions) {
		super(`Room handler was cancelled while waiting for ${roomId}`, options);
		this.name = "RoomHandlerQueueAbortedError";
		this.roomId = roomId;
	}
}

export const DEFAULT_ROOM_HANDLER_QUEUE_MAX_PENDING_PER_ROOM = 32;
export const DEFAULT_ROOM_HANDLER_QUEUE_MAX_PENDING_TOTAL = 512;
export const DEFAULT_ROOM_HANDLER_QUEUE_MAX_ACTIVE_ROOMS = 256;

export class RoomHandlerQueueClosedError extends ElizaError {
	constructor(reason: string) {
		super("Room handler queue is not accepting new work", {
			code: "ROOM_HANDLER_QUEUE_CLOSED",
			context: { reason },
			severity: "ephemeral",
		});
	}
}

export class RoomHandlerQueueGlobalSaturatedError extends ElizaError {
	constructor(
		readonly limitKind: "pending" | "rooms",
		readonly limit: number,
		readonly current: number,
	) {
		super(
			`Room handler queue reached its global ${limitKind} limit (${current}/${limit})`,
			{
				code: "ROOM_HANDLER_QUEUE_GLOBAL_SATURATED",
				context: { limitKind, limit, current },
				severity: "ephemeral",
			},
		);
	}
}

export class RoomHandlerQueueSaturatedError extends ElizaError {
	override readonly name = "RoomHandlerQueueSaturatedError";
	readonly roomId: string;
	readonly maxPendingPerRoom: number;
	readonly pendingCount: number;

	constructor(roomId: string, maxPendingPerRoom: number, pendingCount: number) {
		super(
			`Room handler queue for ${roomId} is full (${pendingCount}/${maxPendingPerRoom})`,
			{
				code: "ROOM_HANDLER_QUEUE_SATURATED",
				context: { roomId, maxPendingPerRoom, pendingCount },
				severity: "ephemeral",
			},
		);
		this.roomId = roomId;
		this.maxPendingPerRoom = maxPendingPerRoom;
		this.pendingCount = pendingCount;
	}
}

export interface RoomHandlerQueueOptions {
	/** Maximum admitted work per room, including the active owner. */
	maxPendingPerRoom?: number;
	/** Maximum admitted work across every room, including active owners. */
	maxPendingTotal?: number;
	/** Maximum distinct non-empty room queues retained at one time. */
	maxActiveRooms?: number;
	/** Diagnostic boundary for telemetry-listener failures. */
	onListenerError?: (error: unknown, event: RoomQueueEvent) => void;
	/**
	 * Force explicit capability propagation when async-local context is unavailable.
	 * Browser and edge runtimes select this mode automatically.
	 */
	asyncContext?: "auto" | "explicit";
}

export interface RoomHandlerLease {
	/** Release the room after the caller's complete durable outcome is settled. */
	release(): Promise<void>;
}

interface RoomHandlerOwnershipContext {
	lease: RoomHandlerLease;
	roomId: string;
}

interface RoomHandlerOwnershipStorage {
	getStore(): RoomHandlerOwnershipContext | undefined;
	run<T>(context: RoomHandlerOwnershipContext, fn: () => T): T;
}

let roomHandlerOwnershipStorage: RoomHandlerOwnershipStorage | null | undefined;

function getRoomHandlerOwnershipStorage(): RoomHandlerOwnershipStorage | null {
	if (roomHandlerOwnershipStorage !== undefined) {
		return roomHandlerOwnershipStorage;
	}
	if (
		typeof process !== "undefined" &&
		typeof process.getBuiltinModule === "function"
	) {
		const { AsyncLocalStorage } = process.getBuiltinModule(
			"node:async_hooks",
		) as typeof import("node:async_hooks");
		roomHandlerOwnershipStorage =
			new AsyncLocalStorage<RoomHandlerOwnershipContext>();
		return roomHandlerOwnershipStorage;
	}
	roomHandlerOwnershipStorage = null;
	return roomHandlerOwnershipStorage;
}

interface RunWithOptions {
	/** Cancellation applies only while the work is queued, never after it starts. */
	signal?: AbortSignal;
}

export interface WithRoomHandlerLeaseOptions {
	/** Cancellation applies only while ownership is queued. */
	signal?: AbortSignal;
	/** Exact live capability to reuse when async-local context is unavailable. */
	lease?: RoomHandlerLease;
}

class RoomQueue {
	readonly roomId: string;
	private queue: QueuedItem<unknown>[] = [];
	private active: QueuedItem<unknown> | null = null;

	constructor(roomId: string) {
		this.roomId = roomId;
	}

	get pendingCount(): number {
		return this.queue.length + (this.active ? 1 : 0);
	}

	enqueue<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) {
			return Promise.reject(
				new RoomHandlerQueueAbortedError(this.roomId, {
					cause: signal.reason,
				}),
			);
		}
		return new Promise<T>((resolve, reject) => {
			const item: QueuedItem<unknown> = {
				fn: fn as () => Promise<unknown>,
				resolve: resolve as (value: unknown) => void,
				reject,
				enqueuedAt: Date.now(),
				signal,
			};
			if (signal) {
				const onAbort = () => {
					const index = this.queue.indexOf(item);
					if (index < 0) return;
					this.queue.splice(index, 1);
					signal.removeEventListener("abort", onAbort);
					item.reject(
						new RoomHandlerQueueAbortedError(this.roomId, {
							cause: signal.reason,
						}),
					);
				};
				item.onAbort = onAbort;
				signal.addEventListener("abort", onAbort, { once: true });
			}
			this.queue.push(item);
			this.drain();
		});
	}

	/** Wait until the queue is empty AND no handler is running. */
	async quiesce(): Promise<void> {
		while (this.queue.length > 0 || this.active) {
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
		}
	}

	private drain(): void {
		if (this.active) return;
		const next = this.queue.shift();
		if (!next) return;
		if (next.signal && next.onAbort) {
			next.signal.removeEventListener("abort", next.onAbort);
		}
		this.active = next;
		Promise.resolve()
			.then(() => next.fn())
			.then(
				(value) => {
					next.resolve(value);
					this.active = null;
					this.drain();
				},
				(error) => {
					next.reject(error);
					this.active = null;
					this.drain();
				},
			);
	}
}

export class RoomHandlerQueue {
	private rooms = new Map<string, RoomQueue>();
	private listeners = new Set<(event: RoomQueueEvent) => void>();
	private activeLeases = new WeakMap<
		RoomHandlerLease,
		{
			roomId: string;
			released: boolean;
			accepting: boolean;
			writerTail: Promise<void>;
		}
	>();
	readonly maxPendingPerRoom: number;
	readonly maxPendingTotal: number;
	readonly maxActiveRooms: number;
	private admissionClosedReason: string | null = null;
	private readonly onListenerError?: (
		error: unknown,
		event: RoomQueueEvent,
	) => void;
	private readonly ownershipStorage: RoomHandlerOwnershipStorage | null;

	constructor(options: RoomHandlerQueueOptions = {}) {
		const maxPendingPerRoom =
			options.maxPendingPerRoom ??
			DEFAULT_ROOM_HANDLER_QUEUE_MAX_PENDING_PER_ROOM;
		if (!Number.isSafeInteger(maxPendingPerRoom) || maxPendingPerRoom < 1) {
			throw new RangeError("maxPendingPerRoom must be a positive safe integer");
		}
		this.maxPendingPerRoom = maxPendingPerRoom;
		const maxPendingTotal =
			options.maxPendingTotal ?? DEFAULT_ROOM_HANDLER_QUEUE_MAX_PENDING_TOTAL;
		const maxActiveRooms =
			options.maxActiveRooms ?? DEFAULT_ROOM_HANDLER_QUEUE_MAX_ACTIVE_ROOMS;
		if (!Number.isSafeInteger(maxPendingTotal) || maxPendingTotal < 1) {
			throw new RangeError("maxPendingTotal must be a positive safe integer");
		}
		if (!Number.isSafeInteger(maxActiveRooms) || maxActiveRooms < 1) {
			throw new RangeError("maxActiveRooms must be a positive safe integer");
		}
		this.maxPendingTotal = maxPendingTotal;
		this.maxActiveRooms = maxActiveRooms;
		this.onListenerError = options.onListenerError;
		this.ownershipStorage =
			options.asyncContext === "explicit"
				? null
				: getRoomHandlerOwnershipStorage();
	}

	/**
	 * Run `fn` serialized against any other call for the same `roomId`. If a
	 * prior handler for `roomId` is still running, `fn` waits in line until
	 * the prior handler resolves (or rejects — failures don't block the queue).
	 */
	async runWith<T>(
		roomId: string,
		fn: () => Promise<T>,
		options?: RunWithOptions,
	): Promise<T> {
		return this.runQueued(roomId, fn, options);
	}

	private async runQueued<T>(
		roomId: string,
		fn: () => Promise<T>,
		options?: RunWithOptions,
	): Promise<T> {
		if (this.admissionClosedReason !== null) {
			throw new RoomHandlerQueueClosedError(this.admissionClosedReason);
		}
		if (options?.signal?.aborted) {
			const error = new RoomHandlerQueueAbortedError(roomId, {
				cause: options.signal.reason,
			});
			this.emit({ type: "cancelled", roomId });
			throw error;
		}
		const existingQueue = this.rooms.get(roomId);
		if (!existingQueue && this.rooms.size >= this.maxActiveRooms) {
			throw new RoomHandlerQueueGlobalSaturatedError(
				"rooms",
				this.maxActiveRooms,
				this.rooms.size,
			);
		}
		const totalPending = this.pendingTotal();
		if (totalPending >= this.maxPendingTotal) {
			throw new RoomHandlerQueueGlobalSaturatedError(
				"pending",
				this.maxPendingTotal,
				totalPending,
			);
		}
		const queue = existingQueue ?? this.getQueue(roomId);
		const queuePosition = queue.pendingCount;
		if (queuePosition >= this.maxPendingPerRoom) {
			const error = new RoomHandlerQueueSaturatedError(
				roomId,
				this.maxPendingPerRoom,
				queuePosition,
			);
			this.emit({
				type: "saturated",
				roomId,
				queueDepth: queuePosition,
				maxPendingPerRoom: this.maxPendingPerRoom,
			});
			if (queue.pendingCount === 0) this.rooms.delete(roomId);
			throw error;
		}
		this.emit({ type: "enqueued", roomId, queueDepth: queuePosition + 1 });
		try {
			const result = await queue.enqueue(fn, options?.signal);
			this.emit({ type: "completed", roomId });
			return result;
		} catch (error) {
			// error-policy:J1 The per-room queue boundary emits its terminal
			// failure state and preserves the handler error.
			if (error instanceof RoomHandlerQueueAbortedError) {
				this.emit({ type: "cancelled", roomId });
			} else {
				this.emit({
					type: "errored",
					roomId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			throw error;
		} finally {
			// Garbage-collect empty queues to keep the map bounded.
			const q = this.rooms.get(roomId);
			if (q && q.pendingCount === 0) {
				this.rooms.delete(roomId);
			}
		}
	}

	/**
	 * Acquire exclusive ownership of a room until the returned lease releases.
	 * A waiting transport may cancel without disturbing active work; after the
	 * lease is granted, its owner alone decides when the durable turn is done.
	 */
	async acquire(
		roomId: string,
		signal?: AbortSignal,
	): Promise<RoomHandlerLease> {
		let markAcquired: (() => void) | undefined;
		let rejectAcquired: ((error: unknown) => void) | undefined;
		const acquired = new Promise<void>((resolve, reject) => {
			markAcquired = resolve;
			rejectAcquired = reject;
		});
		let releaseHold: (() => void) | undefined;
		const hold = new Promise<void>((resolve) => {
			releaseHold = resolve;
		});

		const heldTurn = this.runQueued(
			roomId,
			async () => {
				markAcquired?.();
				await hold;
			},
			{ signal },
		);
		// error-policy:J5 The acquisition promise awaited below observes and
		// forwards rejection from a waiter cancelled before its lease is granted.
		void heldTurn.catch((error) => rejectAcquired?.(error));
		await acquired;

		let released: Promise<void> | null = null;
		const ownership = {
			roomId,
			released: false,
			accepting: true,
			writerTail: Promise.resolve(),
		};
		const lease: RoomHandlerLease = {
			release: () => {
				if (!released) {
					ownership.accepting = false;
					released = (async () => {
						await ownership.writerTail;
						ownership.released = true;
						releaseHold?.();
						await heldTurn;
					})();
				}
				return released;
			},
		};
		this.activeLeases.set(lease, ownership);
		return lease;
	}

	/**
	 * Own a room for the callback's complete persistence + processing boundary.
	 * The lease is opaque and remains valid only until this callback settles.
	 */
	async withLease<T>(
		roomId: string,
		fn: (lease: RoomHandlerLease) => Promise<T>,
		options?: WithRoomHandlerLeaseOptions,
	): Promise<T> {
		if (options?.lease) {
			this.assertLeaseForRoom(roomId, options.lease);
			return await this.runInLease(roomId, options.lease, () =>
				fn(options.lease as RoomHandlerLease),
			);
		}
		const lease = await this.acquire(roomId, options?.signal);
		try {
			return await this.runInLease(roomId, lease, () => fn(lease));
		} finally {
			await lease.release();
		}
	}

	/**
	 * Own multiple rooms in stable lexical order. Ambient ownership may be reused
	 * only for that exact single room; widening a nested transaction fails fast
	 * instead of risking an A→B/B→A deadlock.
	 */
	async withLeases<T>(
		roomIds: Iterable<string>,
		fn: (leases: ReadonlyMap<string, RoomHandlerLease>) => Promise<T>,
		options?: WithRoomHandlerLeaseOptions,
	): Promise<T> {
		const rooms = [...new Set(roomIds)].sort();
		if (rooms.length === 0) return fn(new Map());
		const ambient = this.ownershipStorage?.getStore();
		if (ambient) {
			if (
				rooms.length !== 1 ||
				rooms[0] !== ambient.roomId ||
				!this.ownsLease(ambient.roomId, ambient.lease)
			) {
				throw new ElizaError(
					"Nested room ownership cannot widen across rooms",
					{
						code: "ROOM_HANDLER_CROSS_ROOM_REENTRY",
						context: { ownerRoomId: ambient.roomId, requestedRoomIds: rooms },
					},
				);
			}
			return fn(new Map([[ambient.roomId, ambient.lease]]));
		}
		if (options?.lease) {
			const ownership = this.activeLeases.get(options.lease);
			if (
				!ownership ||
				ownership.released ||
				!ownership.accepting ||
				rooms.length !== 1 ||
				rooms[0] !== ownership.roomId
			) {
				throw new ElizaError(
					"Nested room ownership cannot widen across rooms",
					{
						code: "ROOM_HANDLER_CROSS_ROOM_REENTRY",
						context: {
							ownerRoomId: ownership?.roomId,
							requestedRoomIds: rooms,
						},
					},
				);
			}
			return fn(new Map([[ownership.roomId, options.lease]]));
		}
		const leases = new Map<string, RoomHandlerLease>();
		try {
			for (const roomId of rooms) {
				leases.set(roomId, await this.acquire(roomId, options?.signal));
			}
			return await fn(leases);
		} finally {
			for (const roomId of [...rooms].reverse()) {
				await leases.get(roomId)?.release();
			}
		}
	}

	/**
	 * Serialize message-table writes performed by sibling async work sharing one
	 * outer turn. The outer lease is still the public admission boundary; this
	 * inner FIFO only makes its concurrent durable writes deterministic.
	 */
	async withLeaseWrite<T>(
		roomId: string,
		lease: RoomHandlerLease,
		fn: () => Promise<T>,
	): Promise<T> {
		const ownership = this.activeLeases.get(lease);
		if (
			!ownership ||
			ownership.roomId !== roomId ||
			ownership.released ||
			!ownership.accepting
		) {
			throw new ElizaError("Room ownership capability is not live", {
				code: "ROOM_HANDLER_LEASE_MISMATCH",
				context: { roomId },
			});
		}
		const predecessor = ownership.writerTail;
		const operation = predecessor.then(fn);
		ownership.writerTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	/** Serialize one atomic adapter write across every owned room. */
	async withLeaseWrites<T>(
		leases: ReadonlyMap<string, RoomHandlerLease>,
		fn: () => Promise<T>,
	): Promise<T> {
		const entries = [...leases.entries()].sort(([left], [right]) =>
			left.localeCompare(right),
		);
		const acquireWriter = (index: number): Promise<T> => {
			const entry = entries[index];
			if (!entry) return fn();
			return this.withLeaseWrite(entry[0], entry[1], () =>
				acquireWriter(index + 1),
			);
		};
		return acquireWriter(0);
	}

	/**
	 * Propagate a validated live capability through the work it owns. This is
	 * the only ambient ownership signal used by nested runtime writers; callers
	 * cannot manufacture or reuse it after release.
	 */
	runInLease<T>(roomId: string, lease: RoomHandlerLease, fn: () => T): T {
		this.assertLeaseForRoom(roomId, lease);
		if (!this.ownershipStorage) return fn();
		return this.ownershipStorage.run({ roomId, lease }, fn);
	}

	/** Return the exact live capability inherited by the current async work. */
	currentLease(roomId: string): RoomHandlerLease | undefined {
		const context = this.ownershipStorage?.getStore();
		if (
			!context ||
			context.roomId !== roomId ||
			!this.ownsLease(roomId, context.lease)
		) {
			return undefined;
		}
		return context.lease;
	}

	/** Snapshot the exact live ownership inherited by the current async work. */
	currentOwnership(): RoomHandlerOwnershipContext | undefined {
		const context = this.ownershipStorage?.getStore();
		if (!context || !this.ownsLease(context.roomId, context.lease)) {
			return undefined;
		}
		return context;
	}

	/** Whether this exact live lease owns this queue and room. */
	ownsLease(
		roomId: string,
		lease: RoomHandlerLease | null | undefined,
	): lease is RoomHandlerLease {
		if (!lease) return false;
		const ownership = this.activeLeases.get(lease);
		return (
			ownership !== undefined &&
			ownership.roomId === roomId &&
			!ownership.released &&
			ownership.accepting
		);
	}

	pendingFor(roomId: string): number {
		return this.rooms.get(roomId)?.pendingCount ?? 0;
	}

	pendingTotal(): number {
		let total = 0;
		for (const queue of this.rooms.values()) total += queue.pendingCount;
		return total;
	}

	/** Freeze new admissions while allowing already-admitted work to settle. */
	closeAdmissions(reason: string): void {
		if (this.admissionClosedReason === null) {
			this.admissionClosedReason = reason;
		}
	}

	isAcceptingAdmissions(): boolean {
		return this.admissionClosedReason === null;
	}

	/** Whether callers must propagate the opaque lease without ambient context. */
	requiresExplicitOwnership(): boolean {
		return this.ownershipStorage === null;
	}

	/** Wait for all queued + active work for a room to finish. */
	async quiesce(roomId: string): Promise<void> {
		const queue = this.rooms.get(roomId);
		if (!queue) return;
		await queue.quiesce();
	}

	/** Wait for all queued + active work for every room to finish. */
	async quiesceAll(): Promise<void> {
		await Promise.all([...this.rooms.values()].map((q) => q.quiesce()));
	}

	onEvent(listener: (event: RoomQueueEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private getQueue(roomId: string): RoomQueue {
		let q = this.rooms.get(roomId);
		if (!q) {
			q = new RoomQueue(roomId);
			this.rooms.set(roomId, q);
		}
		return q;
	}

	private assertLeaseForRoom(roomId: string, lease: RoomHandlerLease): void {
		const ownership = this.activeLeases.get(lease);
		if (
			ownership &&
			!ownership.released &&
			ownership.accepting &&
			ownership.roomId !== roomId
		) {
			throw new ElizaError("Nested room ownership cannot widen across rooms", {
				code: "ROOM_HANDLER_CROSS_ROOM_REENTRY",
				context: {
					ownerRoomId: ownership.roomId,
					requestedRoomIds: [roomId],
				},
			});
		}
		if (!this.ownsLease(roomId, lease)) {
			throw new ElizaError("Room ownership capability is not live", {
				code: "ROOM_HANDLER_LEASE_MISMATCH",
				context: { roomId },
			});
		}
	}

	private emit(event: RoomQueueEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				// error-policy:J7 Queue listeners are diagnostics-only, but their
				// failures are reported at the runtime boundary before work continues.
				this.onListenerError?.(error, event);
			}
		}
	}
}

export type RoomQueueEvent =
	| { type: "enqueued"; roomId: string; queueDepth: number }
	| { type: "completed"; roomId: string }
	| { type: "cancelled"; roomId: string }
	| {
			type: "saturated";
			roomId: string;
			queueDepth: number;
			maxPendingPerRoom: number;
	  }
	| { type: "errored"; roomId: string; error: string };
