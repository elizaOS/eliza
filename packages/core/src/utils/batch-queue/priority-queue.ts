import { logger } from "../../logger.js";

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
	// Note: Three separate arrays avoid O(n) linear scan per insertion; enqueue is O(1).
	private invalidPriorityWarned = false;
	private readonly highItems: T[] = [];
	private readonly normalItems: T[] = [];
	private readonly lowItems: T[] = [];
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
		if (max !== undefined && this.size >= max) {
			if (this.onPressure) {
				if (!this.onPressure(this, item)) {
					return false;
				}
			} else {
				this.onOverflowWarning?.(this.size + 1, max);
			}
		}

		this.insertByPriority(item);
		return true;
	}

	private insertByPriority(item: T): void {
		const p = this.getPriority(item);
		if (p === "high") {
			this.highItems.push(item);
		} else if (p === "normal") {
			this.normalItems.push(item);
		} else if (p === "low") {
			this.lowItems.push(item);
		} else {
			if (!this.invalidPriorityWarned) {
				this.invalidPriorityWarned = true;
				logger.warn(
					{ src: "utils:priority-queue", priority: String(p) },
					'Invalid queue priority; expected "high" | "normal" | "low". Treating as normal.',
				);
			}
			this.normalItems.push(item);
		}
		// Note: separates items by priority for efficient batch processing and avoids linear scans.
	}

	/** Remove up to `n` items from the front (highest priority first). */
	dequeueBatch(n: number): T[] {
		if (n <= 0 || this.size === 0) {
			return [];
		}
		const result: T[] = [];
		let remaining = n;

		// Drain from high priority first
		if (remaining > 0 && this.highItems.length > 0) {
			const take = Math.min(remaining, this.highItems.length);
			result.push(...this.highItems.splice(0, take));
			remaining -= take;
		}

		// Then normal priority
		if (remaining > 0 && this.normalItems.length > 0) {
			const take = Math.min(remaining, this.normalItems.length);
			result.push(...this.normalItems.splice(0, take));
			remaining -= take;
		}

		// Then low priority
		if (remaining > 0 && this.lowItems.length > 0) {
			const take = Math.min(remaining, this.lowItems.length);
			result.push(...this.lowItems.splice(0, take));
		}

		return result;
	}

	/** Remove and return all items matching `filter`. */
	drain(filter?: (item: T) => boolean): T[] {
		if (!filter) {
			const all = [...this.highItems, ...this.normalItems, ...this.lowItems];
			this.highItems.length = 0;
			this.normalItems.length = 0;
			this.lowItems.length = 0;
			return all;
		}

		const drainArray = (arr: T[]): T[] => {
			const kept: T[] = [];
			const out: T[] = [];
			for (const item of arr) {
				if (filter(item)) {
					out.push(item);
				} else {
					kept.push(item);
				}
			}
			arr.length = 0;
			arr.push(...kept);
			return out;
		};

		return [
			...drainArray(this.highItems),
			...drainArray(this.normalItems),
			...drainArray(this.lowItems),
		];
	}

	get size(): number {
		return (
			this.highItems.length + this.normalItems.length + this.lowItems.length
		);
	}

	clear(): void {
		this.highItems.length = 0;
		this.normalItems.length = 0;
		this.lowItems.length = 0;
	}

	stats(): PriorityQueueStats {
		return {
			high: this.highItems.length,
			normal: this.normalItems.length,
			low: this.lowItems.length,
			total: this.size,
		};
	}
}
