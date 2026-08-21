/**
 * Deterministic tests for the entity-resolution `{ match: … }` unwrap.
 * No live model: the walker is the production normalizeEntityMatches used
 * on TEXT_SMALL entity-resolution JSON.
 */
import { describe, expect, it } from "vitest";
import { findEntityByName } from "./entities";
import {
	ENTITY_MATCH_UNBOUNDED,
	MAX_ENTITY_MATCH_DEPTH,
	MAX_ENTITY_MATCH_NODES,
	normalizeEntityMatches,
} from "./entity-matches";
import { ElizaError } from "./errors";
import type { IAgentRuntime, Memory, State } from "./types";

function nestMatch(depth: number): unknown {
	let value: unknown = { name: "Ada" };
	for (let index = 0; index < depth; index += 1) {
		value = { match: value };
	}
	return value;
}

describe("normalizeEntityMatches", () => {
	it("unwraps honest match wrappers, arrays, and direct records", () => {
		expect(normalizeEntityMatches({ name: "Ada" })).toEqual([{ name: "Ada" }]);
		expect(normalizeEntityMatches({ match: { name: "Ada" } })).toEqual([
			{ name: "Ada" },
		]);
		expect(
			normalizeEntityMatches({
				match: [{ name: "Ada", reason: "exact" }, { name: "Bob" }],
			}),
		).toEqual([{ name: "Ada", reason: "exact" }, { name: "Bob" }]);
		expect(normalizeEntityMatches(null)).toEqual([]);
	});

	it(`accepts a ${MAX_ENTITY_MATCH_DEPTH}-deep match wrap`, () => {
		expect(normalizeEntityMatches(nestMatch(MAX_ENTITY_MATCH_DEPTH))).toEqual([
			{ name: "Ada" },
		]);
	});

	it(`throws ${ENTITY_MATCH_UNBOUNDED} one past depth ${MAX_ENTITY_MATCH_DEPTH}`, () => {
		try {
			normalizeEntityMatches(nestMatch(MAX_ENTITY_MATCH_DEPTH + 1));
			expect.unreachable("unwrap should fail closed on over-budget depth");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ENTITY_MATCH_UNBOUNDED);
		}
	});

	it(`throws ${ENTITY_MATCH_UNBOUNDED} past ${MAX_ENTITY_MATCH_NODES} sparse holes`, () => {
		const sparse: unknown[] = [];
		sparse[MAX_ENTITY_MATCH_NODES] = { name: "Ada" };
		try {
			normalizeEntityMatches(sparse);
			expect.unreachable(
				"unwrap should fail closed on over-budget sparse length",
			);
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ENTITY_MATCH_UNBOUNDED);
		}
	});

	it("throws on a cyclic match wrapper without hanging", () => {
		const cyclic: { match?: unknown } = {};
		cyclic.match = cyclic;
		const started = performance.now();
		try {
			normalizeEntityMatches(cyclic);
			expect.unreachable("unwrap should fail closed on a cycle");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ENTITY_MATCH_UNBOUNDED);
		}
		expect(performance.now() - started).toBeLessThan(50);
	});

	it("does not invoke accessors while unwrapping", () => {
		let invoked = 0;
		const hostile = {
			get match() {
				invoked += 1;
				return { name: "Ada" };
			},
		};
		try {
			normalizeEntityMatches(hostile);
			expect.unreachable("unwrap should fail closed on enumerable accessors");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ENTITY_MATCH_UNBOUNDED);
		}
		expect(invoked).toBe(0);
	});

	it("does not invoke object Proxy get/has traps while unwrapping", () => {
		let gets = 0;
		let hasCalls = 0;
		const proxy = new Proxy(
			{ match: { name: "Ada" } },
			{
				get() {
					gets += 1;
					throw new Error("get trap escaped");
				},
				has() {
					hasCalls += 1;
					throw new Error("has trap escaped");
				},
			},
		);
		expect(normalizeEntityMatches(proxy)).toEqual([{ name: "Ada" }]);
		expect(gets).toBe(0);
		expect(hasCalls).toBe(0);
	});

	it("does not invoke array Proxy get/has traps while unwrapping", () => {
		let gets = 0;
		let hasCalls = 0;
		const proxy = new Proxy([{ name: "Ada" }], {
			get() {
				gets += 1;
				throw new Error("array get trap escaped");
			},
			has() {
				hasCalls += 1;
				throw new Error("array has trap escaped");
			},
		});
		expect(normalizeEntityMatches(proxy)).toEqual([{ name: "Ada" }]);
		expect(gets).toBe(0);
		expect(hasCalls).toBe(0);
	});

	it("translates descriptor Proxy failures with their cause", () => {
		const proxy = new Proxy(
			{ match: { name: "Ada" } },
			{
				getOwnPropertyDescriptor() {
					throw new Error("hostile descriptor trap");
				},
			},
		);

		try {
			normalizeEntityMatches(proxy);
			expect.unreachable("descriptor failure should be translated");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ENTITY_MATCH_UNBOUNDED);
			expect((error as Error).cause).toMatchObject({
				message: "hostile descriptor trap",
			});
		}
	});

	it("does not invoke outer model-result accessors in findEntityByName", async () => {
		let invoked = 0;
		const modelResult = {};
		Object.defineProperty(modelResult, "matches", {
			enumerable: true,
			get() {
				invoked += 1;
				return { match: { name: "Ada" } };
			},
		});
		const runtime = {
			agentId: "agent",
			getEntitiesForRoom: async () => [],
			getRelationships: async () => [],
			getMemories: async () => [],
			useModel: async () => modelResult,
		} as unknown as IAgentRuntime;
		const message = {
			roomId: "room",
			entityId: "sender",
			content: {},
		} as unknown as Memory;
		const state = {
			data: { room: { id: "room", name: "Room", worldId: null } },
		} as unknown as State;

		await expect(
			findEntityByName(runtime, message, state),
		).rejects.toMatchObject({
			code: ENTITY_MATCH_UNBOUNDED,
		});
		expect(invoked).toBe(0);
	});

	it(`throws ${ENTITY_MATCH_UNBOUNDED} on a revoked Proxy instead of TypeError`, () => {
		const { proxy, revoke } = Proxy.revocable({ match: { name: "Ada" } }, {});
		revoke();
		try {
			normalizeEntityMatches(proxy);
			expect.unreachable("unwrap should fail closed on a revoked Proxy");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ENTITY_MATCH_UNBOUNDED);
			expect((error as Error).name).not.toBe("TypeError");
			expect((error as Error).cause).toBeInstanceOf(TypeError);
		}
	});

	it("rescans repeated shared child matches", () => {
		const shared = { name: "Ada" };
		expect(normalizeEntityMatches([shared, shared])).toEqual([
			{ name: "Ada" },
			{ name: "Ada" },
		]);
	});

	it("fails closed on an 8k match wrap in under 50ms instead of RangeError", () => {
		const started = performance.now();
		try {
			normalizeEntityMatches(nestMatch(8_000));
			expect.unreachable("unwrap should fail closed on an 8k nest");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ENTITY_MATCH_UNBOUNDED);
			expect((error as Error).name).not.toBe("RangeError");
		}
		expect(performance.now() - started).toBeLessThan(50);
	});
});
