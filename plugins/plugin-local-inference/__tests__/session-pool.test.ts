/**
 * SessionPool LRU eviction tests.
 *
 * The pool keeps one `LlamaChatSession` per `promptCacheKey` so prefix
 * caching survives across turns. On overflow the *least-recently-used*
 * entry must evict first, and its `dispose()` MUST complete before the
 * new entry is returned so the caller never holds two live sessions over
 * the same KV memory.
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_SESSION_KEY,
	resolveDefaultPoolSize,
	SessionPool,
} from "../src/services/session-pool";

interface FakeSession {
	id: string;
	disposed: boolean;
	dispose(): Promise<void>;
}

function makeFactory(): {
	pool: SessionPool<FakeSession>;
	created: string[];
	disposed: string[];
} {
	const created: string[] = [];
	const disposed: string[] = [];
	const pool = new SessionPool<FakeSession>({
		maxSize: 2,
		factory: async (key) => {
			created.push(key);
			const session: FakeSession = {
				id: key,
				disposed: false,
				async dispose() {
					this.disposed = true;
					disposed.push(key);
				},
			};
			return session;
		},
	});
	return { pool, created, disposed };
}

describe("SessionPool", () => {
	it("rejects maxSize < 1", () => {
		expect(
			() =>
				new SessionPool({
					maxSize: 0,
					factory: async () => ({}) as never,
				}),
		).toThrow(/maxSize must be >= 1/);
	});

	it("creates a session on first acquire and reuses on second", async () => {
		const { pool, created } = makeFactory();
		const a = await pool.acquire("k1");
		const b = await pool.acquire("k1");
		expect(a).toBe(b);
		expect(created).toEqual(["k1"]);
		expect(pool.size()).toBe(1);
	});

	it("evicts least-recently-used on overflow (LRU=k1, MRU=k2)", async () => {
		const { pool, created, disposed } = makeFactory();
		await pool.acquire("k1");
		await pool.acquire("k2");
		expect(pool.keys()).toEqual(["k1", "k2"]);

		// maxSize=2; acquiring k3 must evict k1 (LRU).
		await pool.acquire("k3");
		expect(created).toEqual(["k1", "k2", "k3"]);
		expect(disposed).toEqual(["k1"]);
		expect(pool.keys()).toEqual(["k2", "k3"]);
	});

	it("touching an entry on acquire promotes it to MRU", async () => {
		const { pool, disposed } = makeFactory();
		await pool.acquire("k1");
		await pool.acquire("k2");
		// Touch k1 so it becomes MRU.
		await pool.acquire("k1");
		expect(pool.keys()).toEqual(["k2", "k1"]);
		// Adding k3 must now evict k2.
		await pool.acquire("k3");
		expect(disposed).toEqual(["k2"]);
		expect(pool.keys()).toEqual(["k1", "k3"]);
	});

	it("evicts repeatedly when maxSize=1 (degenerate single-slot case)", async () => {
		const created: string[] = [];
		const disposed: string[] = [];
		const pool = new SessionPool<FakeSession>({
			maxSize: 1,
			factory: async (key) => {
				created.push(key);
				return {
					id: key,
					disposed: false,
					async dispose() {
						disposed.push(key);
					},
				};
			},
		});
		await pool.acquire("a");
		await pool.acquire("b");
		await pool.acquire("c");
		expect(created).toEqual(["a", "b", "c"]);
		expect(disposed).toEqual(["a", "b"]);
		expect(pool.keys()).toEqual(["c"]);
	});

	it("drop(key) tears down only the requested entry", async () => {
		const { pool, disposed } = makeFactory();
		await pool.acquire("k1");
		await pool.acquire("k2");
		await pool.drop("k1");
		expect(disposed).toEqual(["k1"]);
		expect(pool.keys()).toEqual(["k2"]);
		// Dropping a missing key is a no-op.
		await pool.drop("missing");
		expect(disposed).toEqual(["k1"]);
	});

	it("close() disposes every live session and leaves the pool reusable", async () => {
		const { pool, disposed } = makeFactory();
		await pool.acquire("k1");
		await pool.acquire("k2");
		await pool.close();
		expect(disposed.sort()).toEqual(["k1", "k2"]);
		expect(pool.size()).toBe(0);
		// Reusable after close.
		await pool.acquire("k3");
		expect(pool.keys()).toEqual(["k3"]);
	});

	it("dispose() errors are swallowed so the slot is always freed", async () => {
		const created: string[] = [];
		const pool = new SessionPool<FakeSession>({
			maxSize: 1,
			factory: async (key) => {
				created.push(key);
				return {
					id: key,
					disposed: false,
					async dispose() {
						throw new Error("binding crashed");
					},
				};
			},
		});
		await pool.acquire("k1");
		// Overflow forces dispose; despite the throw, k2 must still be returned.
		const k2 = await pool.acquire("k2");
		expect(k2.id).toBe("k2");
		expect(pool.keys()).toEqual(["k2"]);
	});

	it("DEFAULT_SESSION_KEY is the shared synthetic slot for un-keyed callers", () => {
		expect(DEFAULT_SESSION_KEY).toBe("_default");
	});
});

describe("resolveDefaultPoolSize", () => {
	it("defaults to 8 when env is empty", () => {
		expect(resolveDefaultPoolSize(undefined)).toBe(8);
		expect(resolveDefaultPoolSize(null)).toBe(8);
		expect(resolveDefaultPoolSize("")).toBe(8);
	});

	it("respects valid numeric env values, clamped to [1, 64]", () => {
		expect(resolveDefaultPoolSize("4")).toBe(4);
		expect(resolveDefaultPoolSize("1")).toBe(1);
		expect(resolveDefaultPoolSize("64")).toBe(64);
		expect(resolveDefaultPoolSize("128")).toBe(64);
		expect(resolveDefaultPoolSize("-3")).toBe(8);
		expect(resolveDefaultPoolSize("notanumber")).toBe(8);
	});
});
