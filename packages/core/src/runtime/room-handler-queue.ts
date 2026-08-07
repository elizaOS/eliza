/**
 * Serializes handler work per room while allowing unrelated rooms to proceed.
 * Every item runs independently in arrival order; intent coalescing remains a
 * planner concern. Waiting transports may cancel before acquisition, while an
 * acquired lease remains owned until its complete durable outcome settles.
 */

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

export interface RoomHandlerLease {
	/** Release the room after the caller's complete durable outcome is settled. */
	release(): Promise<void>;
}

interface RunWithOptions {
	/** Cancellation applies only while the work is queued, never after it starts. */
	signal?: AbortSignal;
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
		const queue = this.getQueue(roomId);
		const queuePosition = queue.pendingCount;
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

		const heldTurn = this.runWith(
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
		return {
			release: () => {
				if (!released) {
					releaseHold?.();
					released = heldTurn;
				}
				return released;
			},
		};
	}

	pendingFor(roomId: string): number {
		return this.rooms.get(roomId)?.pendingCount ?? 0;
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

	private emit(event: RoomQueueEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// error-policy:J7 Queue listeners are telemetry observers.
				// Listener errors swallowed.
			}
		}
	}
}

export type RoomQueueEvent =
	| { type: "enqueued"; roomId: string; queueDepth: number }
	| { type: "completed"; roomId: string }
	| { type: "cancelled"; roomId: string }
	| { type: "errored"; roomId: string; error: string };
