/**
 * Unit-level coverage for `runtime/fact-write-dedupe` exports: the fact-text
 * canonicalization key, the room+entity scoped equivalence lookup feeding the
 * facts write path in `runtime.ts` (pool query shape, id/scope gates,
 * first-match semantics), and the field-wise stronger-metadata merge rules.
 * The sibling `fact-write-dedupe.test.ts` covers the same guard end-to-end
 * through a real runtime; this suite pins the helper contracts directly with a
 * deterministic in-memory getMemories stub. No runtime, no database.
 */
import { describe, expect, it } from "vitest";
import type { Memory } from "../../types/memory";
import type { IAgentRuntime } from "../../types/runtime";
import {
	findEquivalentFact,
	mergeStrongerFactMetadata,
	normalizeFactTextKey,
} from "../fact-write-dedupe";

const ROOM_A = "11111111-1111-4111-8111-111111111111";
const ENTITY_A = "33333333-3333-4333-8333-333333333333";
const ENTITY_B = "44444444-4444-4444-8444-444444444444";
const ID_EXISTING = "55555555-5555-4555-8555-555555555555";
const ID_INCOMING = "66666666-6666-4666-8666-666666666666";
const ID_OTHER = "77777777-7777-4777-8777-777777777777";

function factMemory(overrides: Partial<Memory> & { text: string }): Memory {
	const { text, ...rest } = overrides;
	return { entityId: ENTITY_A, roomId: ROOM_A, content: { text }, ...rest };
}

/**
 * Collects getMemories queries and replays `rows`. Typed against the runtime
 * pick the module actually requests so the stub cannot drift from the real
 * collaborator shape.
 */
function makeRuntime(rows: Memory[]): {
	runtime: Pick<IAgentRuntime, "getMemories">;
	queries: unknown[];
} {
	const queries: unknown[] = [];
	const runtime: Pick<IAgentRuntime, "getMemories"> = {
		getMemories: async (params) => {
			queries.push(params);
			return rows;
		},
	};
	return { runtime, queries };
}

describe("normalizeFactTextKey", () => {
	it("is case-, punctuation-, and whitespace-insensitive", () => {
		expect(normalizeFactTextKey("  Hello,  WORLD!!  ")).toBe("hello world");
	});

	it("keeps unicode letters and digits, collapsing the rest to single spaces", () => {
		expect(normalizeFactTextKey("L'Été — 2026年…")).toBe("l été 2026年");
	});

	it("collapses runs of separators between words into one space", () => {
		expect(normalizeFactTextKey("a--b//c\t\td")).toBe("a b c d");
	});

	it("reduces punctuation-only or blank text to an empty key", () => {
		expect(normalizeFactTextKey("!!! ... ???")).toBe("");
		expect(normalizeFactTextKey("   ")).toBe("");
	});
});

describe("findEquivalentFact", () => {
	it("returns the existing row when normalized text, room, and entity match", async () => {
		const existing = factMemory({
			id: ID_EXISTING,
			text: "Prefers  morning walks.",
		});
		const { runtime } = makeRuntime([existing]);
		const found = await findEquivalentFact(
			runtime,
			factMemory({ id: ID_INCOMING, text: "prefers MORNING walks" }),
		);
		expect(found).toBe(existing);
	});

	it("queries the bounded facts pool with the incoming room and uniqueness off", async () => {
		const { runtime, queries } = makeRuntime([]);
		await findEquivalentFact(
			runtime,
			factMemory({ id: ID_INCOMING, text: "some fact" }),
		);
		expect(queries).toEqual([
			{
				tableName: "facts",
				roomId: ROOM_A,
				count: 120,
				unique: false,
			},
		]);
	});

	it("ignores a row sharing the incoming id (adapter idempotence, not duplicate)", async () => {
		const same = factMemory({ id: ID_INCOMING, text: "same claim" });
		const { runtime } = makeRuntime([same]);
		const found = await findEquivalentFact(
			runtime,
			factMemory({ id: ID_INCOMING, text: "same claim" }),
		);
		expect(found).toBeNull();
	});

	it("skips rows with no id and rows from a different entity", async () => {
		const noId = factMemory({ text: "same claim" });
		const otherEntity = factMemory({
			id: ID_OTHER,
			text: "same claim",
			entityId: ENTITY_B,
		});
		const { runtime } = makeRuntime([noId, otherEntity]);
		const found = await findEquivalentFact(
			runtime,
			factMemory({ id: ID_INCOMING, text: "same claim" }),
		);
		expect(found).toBeNull();
	});

	it("treats a missing entity on one side as different from a set entity", async () => {
		const existing = factMemory({
			id: ID_EXISTING,
			text: "same claim",
			entityId: ENTITY_A,
		});
		const { runtime } = makeRuntime([existing]);
		const incoming = {
			...factMemory({ id: ID_INCOMING, text: "same claim" }),
			entityId: undefined,
		};
		const found = await findEquivalentFact(runtime, incoming);
		expect(found).toBeNull();
	});

	it("returns the first equivalent row when several match", async () => {
		const first = factMemory({ id: ID_EXISTING, text: "same claim" });
		const second = factMemory({ id: ID_OTHER, text: "same   claim!" });
		const { runtime } = makeRuntime([first, second]);
		const found = await findEquivalentFact(
			runtime,
			factMemory({ id: ID_INCOMING, text: "same claim" }),
		);
		expect(found).toBe(first);
	});

	it("never queries and returns null when the text normalizes to empty", async () => {
		const { runtime, queries } = makeRuntime([
			factMemory({ id: ID_EXISTING, text: "..." }),
		]);
		const found = await findEquivalentFact(
			runtime,
			factMemory({ id: ID_INCOMING, text: "!!!" }),
		);
		expect(found).toBeNull();
		expect(queries).toEqual([]);
	});

	it("returns null without querying when the memory has no roomId", async () => {
		const { runtime, queries } = makeRuntime([]);
		const found = await findEquivalentFact(
			runtime,
			factMemory({
				id: ID_INCOMING,
				text: "orphan fact",
				roomId: undefined,
			}),
		);
		expect(found).toBeNull();
		expect(queries).toEqual([]);
	});
});

describe("mergeStrongerFactMetadata", () => {
	it("returns null when the incoming occurrence adds nothing", () => {
		const existing = factMemory({
			id: ID_EXISTING,
			text: "claim",
			metadata: { confidence: 0.9, kind: "durable" },
		});
		const incoming = factMemory({
			id: ID_INCOMING,
			text: "claim",
			metadata: { confidence: 0.5 },
		});
		expect(mergeStrongerFactMetadata(existing, incoming)).toBeNull();
	});

	it("upgrades confidence when strictly higher and preserves other kept fields", () => {
		const existing = factMemory({
			id: ID_EXISTING,
			text: "claim",
			metadata: { confidence: 0.4, source: "facts-evaluator" },
		});
		const incoming = factMemory({
			id: ID_INCOMING,
			text: "claim",
			metadata: { confidence: 0.8 },
		});
		expect(mergeStrongerFactMetadata(existing, incoming)).toEqual({
			confidence: 0.8,
			source: "facts-evaluator",
		});
	});

	it("stamps confidence when the kept row has none, ignoring non-finite values", () => {
		const existing = factMemory({
			id: ID_EXISTING,
			text: "claim",
			metadata: {},
		});
		expect(
			mergeStrongerFactMetadata(existing, {
				...existing,
				metadata: { confidence: Number.NaN },
			}),
		).toBeNull();
		expect(
			mergeStrongerFactMetadata(existing, {
				...existing,
				metadata: { confidence: 0.1 },
			}),
		).toEqual({ confidence: 0.1 });
	});

	it("treats equal confidence as no upgrade (strictly higher required)", () => {
		const existing = factMemory({
			id: ID_EXISTING,
			text: "claim",
			metadata: { confidence: 0.7 },
		});
		expect(
			mergeStrongerFactMetadata(existing, {
				...existing,
				metadata: { confidence: 0.7 },
			}),
		).toBeNull();
	});

	it("stamps kind only when the kept row lacks one", () => {
		const withoutKind = factMemory({
			id: ID_EXISTING,
			text: "claim",
			metadata: {},
		});
		expect(
			mergeStrongerFactMetadata(withoutKind, {
				...withoutKind,
				metadata: { kind: "current" },
			}),
		).toEqual({ kind: "current" });

		const withKind = factMemory({
			id: ID_EXISTING,
			text: "claim",
			metadata: { kind: "durable" },
		});
		expect(
			mergeStrongerFactMetadata(withKind, {
				...withKind,
				metadata: { kind: "current" },
			}),
		).toBeNull();
	});

	it("upgrades timestamp fields only when strictly more recent or newly present", () => {
		const existing = factMemory({
			id: ID_EXISTING,
			text: "claim",
			metadata: {
				validAt: "2026-01-01T00:00:00.000Z",
				lastConfirmedAt: "2026-03-01T00:00:00.000Z",
			},
		});
		expect(
			mergeStrongerFactMetadata(existing, {
				...existing,
				metadata: {
					validAt: "2026-06-01T00:00:00.000Z",
					lastConfirmedAt: "2026-02-01T00:00:00.000Z",
				},
			}),
		).toEqual({
			validAt: "2026-06-01T00:00:00.000Z",
			lastConfirmedAt: "2026-03-01T00:00:00.000Z",
		});
	});

	it("treats equal timestamps as no upgrade (strictly more recent required)", () => {
		const existing = factMemory({
			id: ID_EXISTING,
			text: "claim",
			metadata: { validAt: "2026-01-01T00:00:00.000Z" },
		});
		expect(
			mergeStrongerFactMetadata(existing, {
				...existing,
				metadata: { validAt: "2026-01-01T00:00:00.000Z" },
			}),
		).toBeNull();
	});

	it("ignores invalid incoming timestamps and upgrades when the kept value is unparseable", () => {
		const existing = factMemory({
			id: ID_EXISTING,
			text: "claim",
			metadata: { validAt: "not-a-date" },
		});
		expect(
			mergeStrongerFactMetadata(existing, {
				...existing,
				metadata: {
					validAt: "garbage",
					lastConfirmedAt: "2026-01-02T03:04:05.000Z",
				},
			}),
		).toEqual({
			validAt: "not-a-date",
			lastConfirmedAt: "2026-01-02T03:04:05.000Z",
		});
	});

	it("combines concurrent upgrades from one occurrence", () => {
		const existing = factMemory({
			id: ID_EXISTING,
			text: "claim",
			metadata: { confidence: 0.2 },
		});
		const merged = mergeStrongerFactMetadata(existing, {
			...existing,
			metadata: {
				confidence: 0.9,
				kind: "durable",
				validAt: "2026-08-25T00:00:00.000Z",
			},
		});
		expect(merged).toEqual({
			confidence: 0.9,
			kind: "durable",
			validAt: "2026-08-25T00:00:00.000Z",
		});
	});

	it("treats missing metadata on the kept row as empty fact metadata", () => {
		const existing = factMemory({ id: ID_EXISTING, text: "claim" });
		expect(
			mergeStrongerFactMetadata(existing, {
				...existing,
				metadata: { kind: "durable" },
			}),
		).toEqual({ kind: "durable" });
	});
});
