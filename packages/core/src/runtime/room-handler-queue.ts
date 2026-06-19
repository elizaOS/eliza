/**
 * RoomHandlerQueue — one handler at a time per room.
 *
 * Without this, two messages arriving for the same room within ~10ms each
 * spawn their own handler invocation, leading to:
 *   - Concurrent Stage-1 calls for the same conversation
 *   - Racing thread mutations
 *   - Reply ordering that contradicts the user's perception
 *
 * This is the deterministic replacement for time-based debouncing. Per the
 * Wave 0 contract, we explicitly do NOT debounce; instead we serialize.
 *
 * Behavior:
 *   - First message arrives → handler starts immediately.
 *   - Second message arrives while first handler runs → queued behind it.
 *   - When the first handler finishes, the next queued message starts.
 *   - Queue per `roomId`. Different rooms run in parallel.
 *
 * The queue does NOT coalesce messages. If three messages queue, the handler
 * runs three times. Coalescing (handling "i need to" + "send" + "an email"
 * as one intent) is a planner-level decision — the planner has all queued
 * messages in its conversation history and can decide to merge them, ask
 * for more info, or process independently.
 *
 * Crash safety: this queue is in-memory. A crash drops the queue. Connectors
 * are expected to re-deliver unacknowledged messages on reconnect.
 */

interface QueuedItem<T> {
	fn: () => Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
	enqueuedAt: number;
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

	enqueue<T>(fn: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.queue.push({
				fn: fn as () => Promise<unknown>,
				resolve: resolve as (value: unknown) => void,
				reject,
				enqueuedAt: Date.now(),
			});
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
	async runWith<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
		const queue = this.getQueue(roomId);
		const queuePosition = queue.pendingCount;
		this.emit({ type: "enqueued", roomId, queueDepth: queuePosition + 1 });
		try {
			const result = await queue.enqueue(fn);
			this.emit({ type: "completed", roomId });
			return result;
		} catch (error) {
			this.emit({
				type: "errored",
				roomId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		} finally {
			// Garbage-collect empty queues to keep the map bounded.
			const q = this.rooms.get(roomId);
			if (q && q.pendingCount === 0) {
				this.rooms.delete(roomId);
			}
		}
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
				// Listener errors swallowed.
			}
		}
	}
}

export type RoomQueueEvent =
	| { type: "enqueued"; roomId: string; queueDepth: number }
	| { type: "completed"; roomId: string }
	| { type: "errored"; roomId: string; error: string };
