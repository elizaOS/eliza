/**
 * Unit tests for per-project memory scoping (#13776 item 4, design D3).
 *
 * These prove the worldId-mapping scoping contract as pure logic AND against a
 * faithful store stub that implements EXACTLY the documented `getMemories`
 * worldId filter line (`if (params.worldId && m.worldId !== params.worldId)
 * return false;` — see plugins/plugin-inmemorydb/adapter.ts:572). That stub is
 * the *store contract*, not a mock of the code under test: the functions under
 * test are the real `project-memory-scope` helpers; the stub only stands in for
 * the database's already-shipped worldId filter so the roundtrip runs without a
 * PGlite/adapter boot in a core unit test. (A real-adapter roundtrip lives in
 * plugins/plugin-inmemorydb/project-memory-scope.roundtrip.test.ts.)
 */

import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors.ts";
import type { UUID } from "../types/primitives.ts";
import { stringToUuid } from "../utils.ts";
import {
	assertMemoriesInProject,
	projectWorldId,
	scopeMemoryFilterToProject,
	scopeMemoryToProject,
} from "./project-memory-scope.ts";

const AGENT_A = stringToUuid("agent-a");
const PROJECT_A = "project-a-id";
const PROJECT_B = "project-b-id";

/**
 * Faithful stand-in for a worldId-filtering memory store. Replicates the exact
 * filter semantics the real adapters ship: no worldId in the query ⇒ everything;
 * worldId in the query ⇒ only exact-match rows. This is the store contract our
 * scoping composes with, kept tiny so the unit test needs no adapter boot.
 */
interface StoreMemory {
	id: string;
	worldId?: UUID;
	text: string;
}
class WorldFilterStore {
	private rows: StoreMemory[] = [];
	create(m: StoreMemory): void {
		this.rows.push(m);
	}
	getMemories(params: { worldId?: UUID }): StoreMemory[] {
		return this.rows.filter((m) => {
			// EXACT documented adapter semantics (adapter.ts:572):
			if (params.worldId && m.worldId !== params.worldId) return false;
			return true;
		});
	}
}

describe("project-memory-scope: projectWorldId derivation", () => {
	it("is deterministic and matches createUniqueUuid derivation", () => {
		const w1 = projectWorldId(AGENT_A, PROJECT_A);
		const w2 = projectWorldId(AGENT_A, PROJECT_A);
		expect(w1).toBe(w2);
		// Must equal the exact string createUniqueUuid(runtime, "project:"+id)
		// would produce: stringToUuid(`project:<id>:<agentId>`).
		expect(w1).toBe(stringToUuid(`project:${PROJECT_A}:${AGENT_A}`));
	});

	it("gives distinct worlds for distinct projects", () => {
		expect(projectWorldId(AGENT_A, PROJECT_A)).not.toBe(
			projectWorldId(AGENT_A, PROJECT_B),
		);
	});

	it("gives distinct worlds per agent (worlds are agent-scoped)", () => {
		const agentB = stringToUuid("agent-b");
		expect(projectWorldId(AGENT_A, PROJECT_A)).not.toBe(
			projectWorldId(agentB, PROJECT_A),
		);
	});

	it("rejects empty projectId / agentId", () => {
		expect(() => projectWorldId(AGENT_A, "")).toThrowError(ElizaError);
		expect(() => projectWorldId(AGENT_A, "   ")).toThrowError(ElizaError);
		expect(() => projectWorldId("" as UUID, PROJECT_A)).toThrowError(
			ElizaError,
		);
	});

	it("trims projectId before deriving the project world", () => {
		expect(projectWorldId(AGENT_A, `  ${PROJECT_A}  `)).toBe(
			projectWorldId(AGENT_A, PROJECT_A),
		);
	});
});

describe("project-memory-scope: (a) scoped write -> scoped read roundtrip", () => {
	it("a memory written under a project is retrievable under that project scope", () => {
		const store = new WorldFilterStore();

		// WRITE: stamp the project world.
		const memory = scopeMemoryToProject(
			{ id: "m1", text: "project A note" },
			{ agentId: AGENT_A, projectId: PROJECT_A },
		);
		expect(memory.worldId).toBe(projectWorldId(AGENT_A, PROJECT_A));
		store.create(memory);

		// READ: scope the filter to the same project.
		const filter = scopeMemoryFilterToProject(
			{},
			{ agentId: AGENT_A, projectId: PROJECT_A },
		);
		const rows = assertMemoriesInProject(store.getMemories(filter), {
			agentId: AGENT_A,
			projectId: PROJECT_A,
		});

		expect(rows.map((r) => r.id)).toEqual(["m1"]);
	});
});

describe("project-memory-scope: (b) cross-project isolation (A cannot read B)", () => {
	it("a project A read never returns project B memories", () => {
		const store = new WorldFilterStore();
		store.create(
			scopeMemoryToProject(
				{ id: "a1", text: "A secret" },
				{ agentId: AGENT_A, projectId: PROJECT_A },
			),
		);
		store.create(
			scopeMemoryToProject(
				{ id: "b1", text: "B secret" },
				{ agentId: AGENT_A, projectId: PROJECT_B },
			),
		);

		// Read scoped to A.
		const filterA = scopeMemoryFilterToProject(
			{},
			{ agentId: AGENT_A, projectId: PROJECT_A },
		);
		const rowsA = assertMemoriesInProject(store.getMemories(filterA), {
			agentId: AGENT_A,
			projectId: PROJECT_A,
		});
		expect(rowsA.map((r) => r.id)).toEqual(["a1"]);

		// Read scoped to B.
		const filterB = scopeMemoryFilterToProject(
			{},
			{ agentId: AGENT_A, projectId: PROJECT_B },
		);
		const rowsB = assertMemoriesInProject(store.getMemories(filterB), {
			agentId: AGENT_A,
			projectId: PROJECT_B,
		});
		expect(rowsB.map((r) => r.id)).toEqual(["b1"]);
	});

	it("fail-closed guard throws if a store leaks a foreign-project row", () => {
		// Simulate a retrieval path that did NOT push the worldId filter down
		// (e.g. an id-batch fetch) and returned a project-B memory while scoped
		// to project A. The guard must throw rather than silently return it.
		const leaked = scopeMemoryToProject(
			{ id: "b1", text: "B secret" },
			{ agentId: AGENT_A, projectId: PROJECT_B },
		);
		expect(() =>
			assertMemoriesInProject([leaked], {
				agentId: AGENT_A,
				projectId: PROJECT_A,
			}),
		).toThrow(/cross-project leak/);
		expect(() =>
			assertMemoriesInProject([leaked], {
				agentId: AGENT_A,
				projectId: PROJECT_A,
			}),
		).toThrowError(ElizaError);
	});

	it("refuses a filter whose worldId conflicts with the active project", () => {
		expect(() =>
			scopeMemoryFilterToProject(
				{ worldId: projectWorldId(AGENT_A, PROJECT_B) },
				{ agentId: AGENT_A, projectId: PROJECT_A },
			),
		).toThrow(/cross-project read/);
		expect(() =>
			scopeMemoryFilterToProject(
				{ worldId: projectWorldId(AGENT_A, PROJECT_B) },
				{ agentId: AGENT_A, projectId: PROJECT_A },
			),
		).toThrowError(ElizaError);
	});

	it("refuses to write a memory pre-tagged for a different project", () => {
		expect(() =>
			scopeMemoryToProject(
				{ id: "x", worldId: projectWorldId(AGENT_A, PROJECT_B), text: "x" },
				{ agentId: AGENT_A, projectId: PROJECT_A },
			),
		).toThrow(/cross-project memory/);
		expect(() =>
			scopeMemoryToProject(
				{ id: "x", worldId: projectWorldId(AGENT_A, PROJECT_B), text: "x" },
				{ agentId: AGENT_A, projectId: PROJECT_A },
			),
		).toThrowError(ElizaError);
	});
});

describe("project-memory-scope: (c) legacy unscoped memories still work (backward-compat)", () => {
	it("no projectId ⇒ write is unchanged (global memory)", () => {
		const m = { id: "g1", text: "global" };
		expect(scopeMemoryToProject(m, { agentId: AGENT_A })).toBe(m);
		expect(
			scopeMemoryToProject(m, { agentId: AGENT_A }).worldId,
		).toBeUndefined();
	});

	it("no projectId ⇒ read filter is unchanged (global read returns everything)", () => {
		const store = new WorldFilterStore();
		store.create(
			scopeMemoryToProject(
				{ id: "a1", text: "A" },
				{ agentId: AGENT_A, projectId: PROJECT_A },
			),
		);
		store.create({ id: "legacy", text: "no world" }); // pre-scoping memory
		const filter = { id: "legacy" } as Record<string, unknown>;
		// Unscoped read (no projectId) must NOT inject a worldId.
		const scoped = scopeMemoryFilterToProject(filter, { agentId: AGENT_A });
		expect(scoped).toBe(filter);
		expect((scoped as { worldId?: UUID }).worldId).toBeUndefined();
		// Global read sees everything including scoped + legacy rows.
		const rows = store.getMemories({});
		expect(rows.map((r) => r.id).sort()).toEqual(["a1", "legacy"]);
	});

	it("legacy memory (no worldId) passes the scoped guard (not treated as a leak)", () => {
		const legacy = { id: "legacy", text: "pre-scoping" };
		expect(() =>
			assertMemoriesInProject([legacy], {
				agentId: AGENT_A,
				projectId: PROJECT_A,
			}),
		).not.toThrow();
		// And it is returned, preserving retrievability for existing agents.
		const kept = assertMemoriesInProject([legacy], {
			agentId: AGENT_A,
			projectId: PROJECT_A,
		});
		expect(kept.map((r) => r.id)).toEqual(["legacy"]);
	});
});

describe("project-memory-scope: (d) filter normalization consistent with #13948", () => {
	// #13948 normalized the task-store projectId filter to: trim once, treat a
	// whitespace-only projectId as absent, emit a single predicate. The memory
	// scoping switch (`opts.projectId` truthiness) must agree: an empty string is
	// "no project" (global), and a set project injects exactly ONE worldId, never
	// a duplicated/ conflicting predicate.
	it("empty-string projectId behaves as absent (global), like the task filter", () => {
		const filter = {};
		expect(
			scopeMemoryFilterToProject(filter, { agentId: AGENT_A, projectId: "" }),
		).toBe(filter);
		const m = { id: "m", text: "t" };
		expect(scopeMemoryToProject(m, { agentId: AGENT_A, projectId: "" })).toBe(
			m,
		);
	});

	it("whitespace-only projectId behaves as absent (global), like the task filter", () => {
		const filter = {};
		expect(
			scopeMemoryFilterToProject(filter, {
				agentId: AGENT_A,
				projectId: "   ",
			}),
		).toBe(filter);
		const memory = { id: "m", text: "t" };
		expect(
			scopeMemoryToProject(memory, {
				agentId: AGENT_A,
				projectId: "   ",
			}),
		).toBe(memory);
		expect(
			assertMemoriesInProject([memory], {
				agentId: AGENT_A,
				projectId: "   ",
			}),
		).toBeDefined();
	});

	it("trims set projectId values before scoping", () => {
		const scoped = scopeMemoryFilterToProject(
			{},
			{ agentId: AGENT_A, projectId: ` ${PROJECT_A} ` },
		);
		expect(scoped.worldId).toBe(projectWorldId(AGENT_A, PROJECT_A));
	});

	it("a set projectId injects exactly one worldId predicate (idempotent, no duplicate)", () => {
		const once = scopeMemoryFilterToProject(
			{},
			{ agentId: AGENT_A, projectId: PROJECT_A },
		);
		// Re-scoping an already-correctly-scoped filter is a no-op, never a
		// second/ conflicting predicate.
		const twice = scopeMemoryFilterToProject(once, {
			agentId: AGENT_A,
			projectId: PROJECT_A,
		});
		expect(twice.worldId).toBe(projectWorldId(AGENT_A, PROJECT_A));
		expect(Object.keys(twice).filter((k) => k === "worldId")).toHaveLength(1);
	});
});
