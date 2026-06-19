/**
 * Generic union-find (disjoint-set) data structure.
 *
 * Used to compute connected components from pairwise edges. The relationships
 * graph builds identity clusters (members of the same person across platforms)
 * by unioning entities that share a confirmed identity link or a normalized
 * cross-platform handle. Both the runtime-level
 * `agent/src/services/relationships-graph.ts` clusterer and the
 * service-level `RelationshipsService` cluster lookup share this structure
 * to guarantee the same notion of cluster membership.
 *
 * Path compression on find() keeps amortised cost near O(α(n)).
 */
export class UnionFind<T> {
	private readonly parent = new Map<T, T>();

	constructor(initial?: Iterable<T>) {
		if (initial) {
			for (const value of initial) {
				this.add(value);
			}
		}
	}

	/** Idempotently register a node so it has a parent pointer. */
	add(value: T): void {
		if (!this.parent.has(value)) {
			this.parent.set(value, value);
		}
	}

	/** True if the value is known to the structure. */
	has(value: T): boolean {
		return this.parent.has(value);
	}

	/** Find the canonical root of `value`. Adds the node lazily. */
	find(value: T): T {
		this.add(value);
		const current = this.parent.get(value) ?? value;
		if (current === value) {
			return current;
		}
		const root = this.find(current);
		this.parent.set(value, root);
		return root;
	}

	/** Merge the components containing `left` and `right`. */
	union(left: T, right: T): void {
		const leftRoot = this.find(left);
		const rightRoot = this.find(right);
		if (leftRoot !== rightRoot) {
			this.parent.set(rightRoot, leftRoot);
		}
	}

	/** Return all components as arrays of members keyed by root. */
	groups(): Map<T, T[]> {
		const grouped = new Map<T, T[]>();
		for (const value of this.parent.keys()) {
			const root = this.find(value);
			const bucket = grouped.get(root);
			if (bucket) {
				bucket.push(value);
			} else {
				grouped.set(root, [value]);
			}
		}
		return grouped;
	}

	/** Return the members of the component containing `value`. */
	componentOf(value: T): T[] {
		if (!this.parent.has(value)) {
			return [value];
		}
		const root = this.find(value);
		const members: T[] = [];
		for (const candidate of this.parent.keys()) {
			if (this.find(candidate) === root) {
				members.push(candidate);
			}
		}
		return members;
	}
}
