/**
 * In-memory priority queue: **high** items dequeue before **normal**, before **low**.
 *
 * **Why unbounded by default:** Queue entries are cheap; workloads like embedding generation are
 * bounded by API throughput, not array length. Use `maxSize` + `onPressure` only when you
 * explicitly want a cap (e.g. sampling / stale buffers) and can define drop or reject policy.
 *
 * **Why `onPressure` returns boolean:** The caller decides whether to evict, reject the new
 * item, or take other action — we do not silently drop work here.
 */

export type QueuePriority = "high" | "normal" | "low";

export type PriorityQueueStats = {
	high: number;
	normal: number;
	low: number;
	total: number;
};

export interface PriorityQueueOptions<T> {
	getPriority: (item: T) => QueuePriority;
	/** When set and length >= maxSize before enqueue, see {@link onPressure} / overflow behavior. */
	maxSize?: number;
	/**
	 * Called when maxSize is reached before adding `item`. Return true after making room (e.g. dequeue)
	 * so the new item can be inserted; return false to reject `item` (not enqueued).
	 */
	onPressure?: (queue: PriorityQueue<T>, item: T) => boolean;
	/** When maxSize exceeded and no onPressure: still enqueue but notify (queue grows past maxSize). */
	onOverflowWarning?: (sizeAfter: number, maxSize: number) => void;
}

export class PriorityQueue<T> {
	private readonly items: T[] = [];
	private readonly getPriority: (item: T) => QueuePriority;
	private readonly maxSize?: number;
	private readonly onPressure?: (queue: PriorityQueue<T>, item: T) => boolean;
	private readonly onOverflowWarning?: (
		sizeAfter: number,
		maxSize: number,
	) => void;

	constructor(options: PriorityQueueOptions<T>) {
		this.getPriority = options.getPriority;
		this.maxSize = options.maxSize;
		this.onPressure = options.onPressure;
		this.onOverflowWarning = options.onOverflowWarning;
	}

	/**
	 * Insert by priority. Returns false if rejected (onPressure returned false).
	 */
	enqueue(item: T): boolean {
		const max = this.maxSize;
		if (max !== undefined && this.items.length >= max) {
			if (this.onPressure) {
				if (!this.onPressure(this, item)) {
					return false;
				}
			} else {
				this.onOverflowWarning?.(this.items.length + 1, max);
			}
		}

		this.insertByPriority(item);
		return true;
	}

	private insertByPriority(item: T): void {
		const p = this.getPriority(item);
		if (p === "low" || this.items.length === 0) {
			this.items.push(item);
			return;
		}

		let insertIndex = this.items.length;
		for (let i = 0; i < this.items.length; i++) {
			const cur = this.getPriority(this.items[i]);
			if (p === "high") {
				if (cur !== "high") {
					insertIndex = i;
					break;
				}
			} else if (cur === "low") {
				insertIndex = i;
				break;
			}
		}
		this.items.splice(insertIndex, 0, item);
	}

	/** Remove up to `n` items from the front (highest priority first). */
	dequeueBatch(n: number): T[] {
		if (n <= 0 || this.items.length === 0) {
			return [];
		}
		const take = Math.min(n, this.items.length);
		return this.items.splice(0, take);
	}

	/** Remove and return all items matching `filter`. */
	drain(filter?: (item: T) => boolean): T[] {
		if (!filter) {
			const all = this.items.slice();
			this.items.length = 0;
			return all;
		}
		const kept: T[] = [];
		const out: T[] = [];
		for (const item of this.items) {
			if (filter(item)) {
				out.push(item);
			} else {
				kept.push(item);
			}
		}
		this.items.length = 0;
		this.items.push(...kept);
		return out;
	}

	get size(): number {
		return this.items.length;
	}

	clear(): void {
		this.items.length = 0;
	}

	stats(): PriorityQueueStats {
		const stats: PriorityQueueStats = {
			high: 0,
			normal: 0,
			low: 0,
			total: this.items.length,
		};
		for (const item of this.items) {
			stats[this.getPriority(item)]++;
		}
		return stats;
	}
}
