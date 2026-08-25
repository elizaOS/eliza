/**
 * Differential regression harness for entity resolution evidence gates
 * (#24765 / PR #27941 review follow-up). Runs the legacy develop
 * implementation (fixture generated from verified git bytes) and the current
 * implementation over the same generated model-response matrix with the same
 * adapter seams. SCOPE: the harness assumes an already-validated, id-bearing
 * roster (id-less room-entity rejection is covered by
 * entities.resolution-consistency.test.ts) and tests only model-result
 * evaluation — the no-over-rejection claim it derives is about resolution
 * verdicts over consistent rosters, not production-wide roster integrity or
 * contextual-referent binding (also covered by the consistency suite). It
 * asserts (1) the current path never over-rejects: any case
 * the legacy path resolved must resolve to the same entity or be an
 * explicitly pinned intended delta, and (2) every pinned delta class fires at
 * least once, so the pins describe real behavior and cannot silently
 * converge. Expectations are derived from the resolution contract (decisive
 * types, evidence consistency, malformed-evidence rejection), never from
 * either implementation's code, so legacy and current do not agree by
 * construction. Cases are generated deterministically; runtime collaborators
 * are stubbed at documented seams and both implementations consume identical
 * rosters, model results, and relationships.
 */
import { describe, expect, it } from "vitest";
import { findEntityByName } from "../entities";
import type {
	Entity,
	IAgentRuntime,
	Memory,
	Relationship,
	State,
	UUID,
} from "../types";
import { findEntityByName as findEntityByNameLegacy } from "./fixtures/differential-legacy-entities";

const AGENT = "00000000-0000-0000-0000-0000000000aa" as UUID;
const BOB = "00000000-0000-0000-0000-0000000000b0" as UUID;
const ALICE = "00000000-0000-0000-0000-0000000000a1" as UUID;
const CAROL = "00000000-0000-0000-0000-0000000000c1" as UUID;
const OUT_OF_SCOPE = "00000000-0000-0000-0000-0000000000ff" as UUID;
const ROOM = "00000000-0000-0000-0000-0000000000r0" as UUID;

function component(
	entityId: UUID,
	data: Record<string, unknown>,
	id: string,
): NonNullable<Entity["components"]>[number] {
	return {
		id: id as UUID,
		entityId,
		agentId: AGENT,
		roomId: ROOM,
		worldId: ROOM,
		sourceEntityId: entityId,
		type: "discord",
		createdAt: 1,
		data: data as NonNullable<Entity["components"]>[number]["data"],
	};
}

/**
 * Carol shares the alias "Alice Smith" with Alice: exactly one roster label
 * ("Alice Smith") is a genuine 2-hit ambiguity, while "Alice"/"alice" remain
 * unique to Alice (via name and username).
 */
const alice = {
	id: ALICE,
	agentId: AGENT,
	names: ["Alice", "Alice Smith"],
	components: [component(ALICE, { username: "alice", handle: "alice" }, "d1")],
} as Entity;
const bob = {
	id: BOB,
	agentId: AGENT,
	names: ["Bob"],
	components: [component(BOB, { username: "bob", handle: "bob" }, "d2")],
} as Entity;
const carol = {
	id: CAROL,
	agentId: AGENT,
	names: ["Carol", "Alice Smith"],
	components: [component(CAROL, { username: "carol", handle: "carol" }, "d3")],
} as Entity;

const ROSTER = [alice, bob, carol];

function message(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000m1" as UUID,
		entityId: BOB,
		roomId: ROOM,
		agentId: AGENT,
		content: { text },
	} as Memory;
}

const state = {
	values: {},
	data: { room: { id: ROOM, name: "DM", worldId: null } },
	text: "",
} as unknown as State;

function runtime(
	modelResult: unknown,
	relationships: Relationship[],
): IAgentRuntime {
	return {
		agentId: AGENT,
		character: { name: "Eliza" },
		getRoom: async () => ({ id: ROOM, name: "DM", worldId: null }),
		getWorld: async () => null,
		getEntitiesForRoom: async () => ROSTER.map((e) => structuredClone(e)),
		getRelationships: async () => relationships,
		getEntityById: async () => null,
		getMemories: async () => [],
		useModel: async () => modelResult,
	} as unknown as IAgentRuntime;
}

const REL_ALICE = [
	{
		id: "00000000-0000-0000-0000-0000000000r1",
		sourceEntityId: BOB,
		targetEntityId: ALICE,
		agentId: AGENT,
		metadata: { interactions: 2 },
	},
] as Relationship[];

const REFERENT = "who should I ping";

/** Label → roster entities whose name/username/handle normalize to it. */
function labelHits(label: string): Entity[] {
	const key = label.trim().toLowerCase().replace(/^@+/, "");
	return ROSTER.filter((entity) =>
		[entity.names, fields(entity, "username"), fields(entity, "handle")].some(
			(labels) =>
				labels.some(
					(l: string) => l.trim().toLowerCase().replace(/^@+/, "") === key,
				),
		),
	);
}

function fields(entity: Entity, field: "username" | "handle"): string[] {
	return (entity.components ?? [])
		.map((c) => c.data?.[field])
		.filter((v): v is string => typeof v === "string");
}

const TYPE_VARIANTS = [
	"EXACT_MATCH",
	"USERNAME_MATCH",
	"NAME_MATCH",
	"RELATIONSHIP_MATCH",
	"AMBIGUOUS",
	"UNKNOWN",
	"absent",
	"junk-type",
] as const;
type TypeVariant = (typeof TYPE_VARIANTS)[number];

const ID_VARIANTS = [
	"alice-id",
	"bob-id",
	"out-of-scope-id",
	"null",
	"absent",
	"conflict",
	"number-42",
	"string-unknown",
	"resolved-alice",
	"agreeing-alice",
	"resolved-out-of-scope",
	"resolved-number",
] as const;
type IdVariant = (typeof ID_VARIANTS)[number];

const MATCH_VARIANTS = [
	"consistent-label-alice",
	"consistent-label-bob",
	"multi-alias-same-alice",
	"@-prefixed-alice",
	"username-alice",
	"no-matches-empty",
	"absent",
	"unknown-label",
	"ambiguous-label-2-hits",
	"null-matches",
	"number-matches",
	"single-object-match",
	"wrapped-object-match",
	"entry-no-name",
	"entry-number",
	"entry-null",
	"mixed-entries-alice",
	"hole-in-array",
	"mixed-entries-conflict",
	"garbage-string-response",
	"lowercase-type-echo",
	"whitespace-type-echo",
	"match-name-empty",
	"match-name-whitespace",
	"response-number",
	"response-array",
	"response-null",
] as const;
type MatchVariant = (typeof MATCH_VARIANTS)[number];

const REL_VARIANTS = ["none", "positive-alice"] as const;
type RelVariant = (typeof REL_VARIANTS)[number];

/** id variant → the roster entity it names, if any (legacy reads entityId). */
const ID_ENTITY: Partial<Record<IdVariant, Entity>> = {
	"alice-id": alice,
	"bob-id": bob,
	// entityId=ALICE with a contradicting resolvedId: legacy's parse prefers
	// entityId, so the legacy EXACT_MATCH branch resolves Alice.
	conflict: alice,
	// resolvedId alone (no entityId): both parses fall back to resolvedId.
	"resolved-alice": alice,
	// entityId === resolvedId agreeing on Alice.
	"agreeing-alice": alice,
};

/**
 * match variant → the match entries the strict walk admits, with each label's
 * roster hits. Variants absent here either supply no matches or are malformed
 * supplied evidence the walk rejects outright.
 */
const USABLE_ENTRIES: Partial<Record<MatchVariant, { label: string }[]>> = {
	"consistent-label-alice": [{ label: "Alice" }],
	"consistent-label-bob": [{ label: "Bob" }],
	"multi-alias-same-alice": [{ label: "Alice" }, { label: "alice" }],
	"@-prefixed-alice": [{ label: "@alice" }],
	"username-alice": [{ label: "alice" }],
	"single-object-match": [{ label: "Alice" }],
	"wrapped-object-match": [{ label: "Alice" }],
	"unknown-label": [{ label: "Zed" }],
	"ambiguous-label-2-hits": [{ label: "Alice Smith" }],
	"mixed-entries-conflict": [{ label: "Alice" }, { label: "Bob" }],
	"mixed-entries-alice": [{ label: "Alice" }],
	"hole-in-array": [{ label: "Alice" }, { label: "Alice" }],
	"lowercase-type-echo": [{ label: "Alice" }],
	"whitespace-type-echo": [{ label: "Alice" }],
};

/** Supplied match evidence the strict walk rejects as malformed. */
const MALFORMED_MATCHES = new Set<MatchVariant>([
	"null-matches",
	"number-matches",
	"entry-no-name",
	"entry-number",
	"entry-null",
	"mixed-entries-alice",
	"hole-in-array",
	"match-name-empty",
	"match-name-whitespace",
]);

function buildModelResult(
	typeVariant: TypeVariant,
	idVariant: IdVariant,
	matchVariant: MatchVariant,
): unknown {
	if (matchVariant === "garbage-string-response") {
		return "not json at all";
	}
	if (matchVariant === "response-number") return 42;
	if (matchVariant === "response-array") return [{ name: "Alice" }];
	if (matchVariant === "response-null") return null;
	const response: Record<string, unknown> = {};
	if (typeVariant !== "absent") {
		response.type = typeVariant === "junk-type" ? "PROBABLY" : typeVariant;
	}
	switch (idVariant) {
		case "alice-id":
			response.entityId = ALICE;
			break;
		case "bob-id":
			response.entityId = BOB;
			break;
		case "out-of-scope-id":
			response.entityId = OUT_OF_SCOPE;
			break;
		case "null":
			response.entityId = null;
			break;
		case "absent":
			break;
		case "conflict":
			response.entityId = ALICE;
			response.resolvedId = BOB;
			break;
		case "number-42":
			response.entityId = 42;
			break;
		case "string-unknown":
			response.entityId = "who-is-this";
			break;
		case "resolved-alice":
			response.resolvedId = ALICE;
			break;
		case "agreeing-alice":
			response.entityId = ALICE;
			response.resolvedId = ALICE;
			break;
		case "resolved-out-of-scope":
			response.resolvedId = OUT_OF_SCOPE;
			break;
		case "resolved-number":
			response.resolvedId = 42;
			break;
	}
	switch (matchVariant) {
		case "absent":
			break;
		case "no-matches-empty":
			response.matches = [];
			break;
		case "null-matches":
			response.matches = null;
			break;
		case "number-matches":
			response.matches = 42;
			break;
		case "consistent-label-alice":
		case "single-object-match":
			response.matches =
				matchVariant === "single-object-match"
					? { name: "Alice", reason: "compact" }
					: [{ name: "Alice", reason: "named" }];
			break;
		case "wrapped-object-match":
			response.matches = { match: { name: "Alice", reason: "wrapped" } };
			break;
		case "consistent-label-bob":
			response.matches = [{ name: "Bob", reason: "named" }];
			break;
		case "multi-alias-same-alice":
			response.matches = [
				{ name: "Alice", reason: "primary" },
				{ name: "alice", reason: "username" },
			];
			break;
		case "@-prefixed-alice":
			response.matches = [{ name: "@alice", reason: "handle" }];
			break;
		case "username-alice":
			response.matches = [{ name: "alice", reason: "username" }];
			break;
		case "ambiguous-label-2-hits":
			response.matches = [{ name: "Alice Smith", reason: "alias collision" }];
			break;
		case "unknown-label":
			response.matches = [{ name: "Zed", reason: "mystery" }];
			break;
		case "entry-no-name":
			response.matches = [{ reason: "no name" }];
			break;
		case "entry-number":
			response.matches = [42];
			break;
		case "entry-null":
			response.matches = [null];
			break;
		case "mixed-entries-alice":
			response.matches = [
				{ name: "Alice", reason: "named" },
				{ reason: "no name" },
			];
			break;
		case "mixed-entries-conflict":
			response.matches = [
				{ name: "Alice", reason: "one" },
				{ name: "Bob", reason: "two" },
			];
			break;
		case "lowercase-type-echo":
			response.type = "name_match";
			response.entityId = ALICE;
			response.matches = [{ name: "Alice", reason: "lowercase type" }];
			break;
		case "whitespace-type-echo":
			response.type = " NAME_MATCH ";
			response.entityId = ALICE;
			response.matches = [{ name: "Alice", reason: "padded type" }];
			break;
		case "match-name-empty":
			response.matches = [{ name: "", reason: "empty" }];
			break;
		case "match-name-whitespace":
			response.matches = [{ name: "   ", reason: "blank" }];
			break;
		case "hole-in-array": {
			// A sparse array: index 1 is a supplied slot that vanishes.
			const sparse: unknown[] = [{ name: "Alice", reason: "head" }];
			sparse[2] = { name: "Alice", reason: "tail" };
			response.matches = sparse;
			break;
		}
	}
	return response;
}

/**
 * Derives the expected verdict for one matrix case from the resolution
 * contract, plus the legacy verdict, so the test can assert both the no-
 * over-rejection invariant and each intended delta.
 */
function classify(caseDef: {
	typeVariant: TypeVariant;
	idVariant: IdVariant;
	matchVariant: MatchVariant;
	relVariant: RelVariant;
}): {
	current: UUID | null;
	legacy: UUID | null;
	delta: string | null;
} {
	const { typeVariant, idVariant, matchVariant, relVariant } = caseDef;
	// Effective type as the response actually carries it: the two echo
	// variants overwrite `type` wholesale, so the classifier must judge
	// decisiveness on the echoed bytes (case- and whitespace-sensitive).
	const type: string | null =
		matchVariant === "lowercase-type-echo"
			? "name_match"
			: matchVariant === "whitespace-type-echo"
				? " NAME_MATCH "
				: typeVariant === "absent" || typeVariant === "junk-type"
					? null
					: typeVariant;
	const isDecisive =
		type !== null &&
		[
			"EXACT_MATCH",
			"USERNAME_MATCH",
			"NAME_MATCH",
			"RELATIONSHIP_MATCH",
		].includes(type);
	// Probed at the PR head: explicit entityId/resolvedId null is the
	// contract's documented "no id" encoding and behaves as absent.
	const idVariantEffective =
		idVariant === "null" ? ("absent" as const) : idVariant;
	const idEntity = ID_ENTITY[idVariantEffective] ?? ID_ENTITY[idVariant];
	const idMalformed = idVariant === "number-42" || idVariant === "conflict";
	const matchesMalformed = MALFORMED_MATCHES.has(matchVariant);
	const usable = USABLE_ENTRIES[matchVariant] ?? [];
	const relPositive = relVariant === "positive-alice";

	// Legacy verdict, from develop's logic: EXACT_MATCH+id short-circuits;
	// otherwise the first label with any index hit wins (RELATIONSHIP needs
	// positive interaction evidence).
	const nonObjectResponse =
		matchVariant === "garbage-string-response" ||
		matchVariant === "response-number" ||
		matchVariant === "response-array" ||
		matchVariant === "response-null";
	let legacy: UUID | null = null;
	if (!nonObjectResponse) {
		if (type === "EXACT_MATCH" && idEntity) {
			legacy = idEntity.id;
		} else {
			for (const entry of usable) {
				const hit = labelHits(entry.label)[0];
				if (!hit) continue;
				if (type === "RELATIONSHIP_MATCH") {
					if (relPositive && hit.id === ALICE) {
						legacy = hit.id as UUID;
					}
					continue;
				}
				legacy = hit.id as UUID;
				break;
			}
		}
	}

	// Current verdict, from the PR contract: only decisive types; malformed
	// supplied evidence (id or matches) invalidates; every supplied id and
	// label must name exactly one id-bearing roster entity and all agree.
	let current: UUID | null = null;
	if (!nonObjectResponse && isDecisive) {
		if (!idMalformed && !matchesMalformed) {
			const evidence = new Set<UUID>();
			let supplied = false;
			const idInvalidates =
				idVariant === "out-of-scope-id" ||
				idVariant === "string-unknown" ||
				idVariant === "resolved-out-of-scope" ||
				idVariant === "resolved-number";
			let invalid = idInvalidates;
			if (idEntity) {
				supplied = true;
				evidence.add(idEntity.id);
			}
			for (const entry of usable) {
				supplied = true;
				const hits = labelHits(entry.label);
				if (hits.length !== 1) {
					invalid = true;
					break;
				}
				evidence.add(hits[0].id);
			}
			if (supplied && !invalid && evidence.size === 1) {
				const evidenceId = [...evidence][0] as UUID;
				if (type === "RELATIONSHIP_MATCH") {
					if (relPositive && evidenceId === ALICE) current = evidenceId;
				} else {
					current = evidenceId;
				}
			}
		}
	}

	let delta: string | null = null;
	if (legacy !== current) {
		if (legacy !== null && current === null) {
			if (typeVariant === "AMBIGUOUS" || typeVariant === "UNKNOWN")
				delta = "terminal-type-label-resolution-dropped";
			else if (!isDecisive) delta = "nondecisive-type-label-resolution-dropped";
			else if (idMalformed) delta = "malformed-id-tightened";
			else if (matchesMalformed) delta = "malformed-matches-tightened";
			else if (matchVariant === "mixed-entries-conflict")
				delta = "conflicting-labels-tightened";
			else if (
				idEntity &&
				usable.some((e) => labelHits(e.label)[0]?.id !== idEntity.id)
			)
				delta = "conflicting-id-vs-label-tightened";
			else if (matchVariant === "ambiguous-label-2-hits")
				delta = "first-hit-ambiguity-tightened";
			else if (
				idVariant === "out-of-scope-id" ||
				idVariant === "string-unknown" ||
				idVariant === "resolved-out-of-scope" ||
				idVariant === "resolved-number"
			)
				delta = "out-of-scope-id-tightened";
			else delta = "UNEXPECTED-TIGHTENING";
		} else if (legacy === null && current !== null) {
			if (
				idEntity &&
				(usable.length === 0 ||
					usable.every((e) => labelHits(e.label)[0]?.id === idEntity.id)) &&
				matchVariant !== "garbage-string-response"
			) {
				delta = "non-exact-id-accepted";
			} else {
				delta = "UNEXPECTED-BROADENING";
			}
		} else {
			delta = "UNEXPECTED-SUBSTITUTION";
		}
	}
	return { current, legacy, delta };
}

function matrixCases(): {
	typeVariant: TypeVariant;
	idVariant: IdVariant;
	matchVariant: MatchVariant;
	relVariant: RelVariant;
}[] {
	const cases = [];
	for (const typeVariant of TYPE_VARIANTS) {
		for (const idVariant of ID_VARIANTS) {
			for (const matchVariant of MATCH_VARIANTS) {
				for (const relVariant of REL_VARIANTS) {
					cases.push({ typeVariant, idVariant, matchVariant, relVariant });
				}
			}
		}
	}
	return cases;
}

const deltaClassesFired = new Set<string>();

async function runCase(caseDef: {
	typeVariant: TypeVariant;
	idVariant: IdVariant;
	matchVariant: MatchVariant;
	relVariant: RelVariant;
}) {
	const model = buildModelResult(
		caseDef.typeVariant,
		caseDef.idVariant,
		caseDef.matchVariant,
	);
	const relationships =
		caseDef.relVariant === "positive-alice" ? REL_ALICE : [];
	const [legacyFound, currentFound] = await Promise.all([
		findEntityByNameLegacy(
			runtime(model, relationships),
			message(REFERENT),
			state,
		),
		findEntityByName(runtime(model, relationships), message(REFERENT), state),
	]);
	const { legacy, current, delta } = classify(caseDef);

	const label = `${caseDef.typeVariant}/${caseDef.idVariant}/${caseDef.matchVariant}/${caseDef.relVariant}`;

	// The classifier's legacy verdict must match the actual legacy run, or
	// the oracle itself is broken and every other assertion is meaningless.
	expect(legacyFound?.id ?? null, `legacy oracle mismatch: ${label}`).toBe(
		legacy,
	);
	expect(currentFound?.id ?? null, `current oracle mismatch: ${label}`).toBe(
		current,
	);

	if (delta) {
		deltaClassesFired.add(delta);
		expect(
			delta.startsWith("UNEXPECTED-"),
			`unpinned behavior delta ${delta} at ${label}`,
		).toBe(false);
	} else {
		// No-over-rejection invariant: legacy resolution is preserved exactly.
		expect(legacyFound?.id ?? null, `over-rejection at ${label}`).toBe(
			currentFound?.id ?? null,
		);
	}
}

describe("differential matrix: legacy vs current entity resolution", () => {
	for (const typeVariant of TYPE_VARIANTS) {
		it(`agrees or pins deltas across id/match/relationship variants for ${typeVariant}`, async () => {
			const cases = matrixCases().filter((c) => c.typeVariant === typeVariant);
			for (const caseDef of cases) {
				await runCase(caseDef);
			}
		});
	}

	it("every pinned delta class fires at least once", () => {
		// The pins must describe real, observable behavior changes; a class
		// that never fires means the pin is dead text, and one that silently
		// disappears from the matrix would go unnoticed without this.
		for (const expected of [
			"non-exact-id-accepted",
			"first-hit-ambiguity-tightened",
			"conflicting-labels-tightened",
			"conflicting-id-vs-label-tightened",
			"malformed-id-tightened",
			"malformed-matches-tightened",
			"terminal-type-label-resolution-dropped",
			"nondecisive-type-label-resolution-dropped",
			"out-of-scope-id-tightened",
		]) {
			expect(
				deltaClassesFired.has(expected),
				`delta class never fired: ${expected}`,
			).toBe(true);
		}
		expect(deltaClassesFired.size).toBe(9);
	});

	it("is deterministic across repeated runs (subset)", async () => {
		const subset = matrixCases().filter(
			(c) =>
				c.idVariant === "alice-id" ||
				c.matchVariant === "mixed-entries-conflict",
		);
		const firstRun = await Promise.all(
			subset.map((c) => {
				const model = buildModelResult(
					c.typeVariant,
					c.idVariant,
					c.matchVariant,
				);
				const relationships =
					c.relVariant === "positive-alice" ? REL_ALICE : [];
				return findEntityByName(
					runtime(model, relationships),
					message(REFERENT),
					state,
				);
			}),
		);
		const secondRun = await Promise.all(
			subset.map((c) => {
				const model = buildModelResult(
					c.typeVariant,
					c.idVariant,
					c.matchVariant,
				);
				const relationships =
					c.relVariant === "positive-alice" ? REL_ALICE : [];
				return findEntityByName(
					runtime(model, relationships),
					message(REFERENT),
					state,
				);
			}),
		);
		expect(secondRun.map((e: Entity | null) => e?.id ?? null)).toEqual(
			firstRun.map((e: Entity | null) => e?.id ?? null),
		);
	});
});
