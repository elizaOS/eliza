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

	/**
	 * Find the canonical root of `value`. Adds the node lazily.
	 *
	 * Deliberately iterative. `union()` carries no union-by-rank/size
	 * heuristic, so a component whose edges arrive in a chain order
	 * (`union(b, a)`, `union(c, b)`, ...) re-roots one level at a time and
	 * leaves a parent chain as deep as the component is large — that is
	 * exactly the shape `RelationshipsService.buildIdentityUnionFind`'s
	 * frontier walk produces for a path of confirmed identity links. A
	 * recursive walk of that chain costs one JS stack frame per link and
	 * throws `RangeError: Maximum call stack size exceeded` past ~10k
	 * members, so the first `find()`/`componentOf()` after the build — i.e.
	 * `getMemberEntityIds()` — was the frame that died. The two passes below
	 * compress exactly the same set of nodes the recursion did (every node
	 * on the path is repointed at the root), so results are unchanged.
	 */
	find(value: T): T {
		this.add(value);
		let root = value;
		let next = this.parent.get(root) ?? root;
		while (next !== root) {
			root = next;
			next = this.parent.get(root) ?? root;
		}
		let node = value;
		while (node !== root) {
			const parent = this.parent.get(node) ?? root;
			this.parent.set(node, root);
			node = parent;
		}
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

	/** True if `left` and `right` belong to the same connected component. */
	connected(left: T, right: T): boolean {
		if (!this.has(left) || !this.has(right)) {
			return false;
		}
		return this.find(left) === this.find(right);
	}

	/** Total number of registered elements in the structure. */
	get size(): number {
		return this.parent.size;
	}

	/** Clear all elements and reset the structure. */
	clear(): void {
		this.parent.clear();
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
