/**
 * Exercises {@link CorpusPseudonymMap} (#14805): corpus-wide pseudonym
 * consistency — one person = one replacement everywhere.
 *
 *   - deterministic stability across runs, assignment orders, and snapshot
 *     reload (the mapping must never re-shuffle identities),
 *   - the one-person-one-pseudonym hard gate across artifact types (document
 *     full name, second-document first name, chat nickname, transcript
 *     @handle) with a similarly-named second person getting a DIFFERENT one,
 *   - collision behavior: shared aliases are ambiguous (escalated, never
 *     guessed), real-alias-vs-pseudonym collisions re-mint with an audit
 *     trail, identity re-homing throws,
 *   - ruleset interplay: pseudonyms are stable across ruleset bumps while the
 *     content-hash done-markers (`pii:<sha256>:v<ruleset>`) change,
 *   - empty/adversarial input and fail-closed snapshot validation.
 */

import { describe, expect, test } from "vitest";
import {
	CorpusPseudonymMap,
	PseudonymMapIntegrityError,
	type PseudonymMapSnapshot,
} from "./pii-pseudonym-map.js";
import { scrubMarkerKeyForContent } from "./pii-scrub-markers.js";

const SALT = "fixed-test-salt";
const RULESET = "2026.07";

function makeMap(): CorpusPseudonymMap {
	return new CorpusPseudonymMap({ salt: SALT, now: () => 1_750_000_000_000 });
}

describe("CorpusPseudonymMap deterministic stability", () => {
	test("same salt + same clusters => identical pseudonyms across runs", () => {
		const a = makeMap();
		const b = makeMap();
		for (const map of [a, b]) {
			map.assign({
				clusterId: "entity:p1",
				kind: "person",
				aliases: ["John Smith"],
				rulesetVersion: RULESET,
			});
			map.assign({
				clusterId: "entity:o1",
				kind: "org",
				aliases: ["Initech"],
				rulesetVersion: RULESET,
			});
		}
		expect(a.getCluster("entity:p1")?.pseudonym).toBe(
			b.getCluster("entity:p1")?.pseudonym,
		);
		expect(a.getCluster("entity:o1")?.pseudonym).toBe(
			b.getCluster("entity:o1")?.pseudonym,
		);
	});

	test("assignment order does not change cluster pseudonyms (cluster-keyed mint)", () => {
		const forward = makeMap();
		const backward = makeMap();
		const clusters = [
			{ clusterId: "entity:a", kind: "person", aliases: ["Ada Lovelace"] },
			{ clusterId: "entity:b", kind: "person", aliases: ["Blaise Pascal"] },
			{ clusterId: "entity:c", kind: "org", aliases: ["Cyberdyne"] },
		];
		for (const c of clusters) {
			forward.assign({ ...c, rulesetVersion: RULESET });
		}
		for (const c of [...clusters].reverse()) {
			backward.assign({ ...c, rulesetVersion: RULESET });
		}
		for (const c of clusters) {
			expect(forward.getCluster(c.clusterId)?.pseudonym).toBe(
				backward.getCluster(c.clusterId)?.pseudonym,
			);
		}
	});

	test("snapshot round-trip preserves every record and future mints", () => {
		const original = makeMap();
		original.assign({
			clusterId: "entity:p1",
			kind: "person",
			aliases: ["John Smith", "Johnny"],
			identities: [{ platform: "discord", handle: "jsmith" }],
			evidence: ["linked via discord profile"],
			rulesetVersion: RULESET,
		});
		const snapshot = original.toSnapshot();
		const restored = CorpusPseudonymMap.fromSnapshot(snapshot);

		expect(restored.toSnapshot()).toEqual(snapshot);
		expect(restored.getCluster("entity:p1")?.pseudonym).toBe(
			original.getCluster("entity:p1")?.pseudonym,
		);

		// Re-assigning the same cluster after reload keeps the pseudonym; a new
		// cluster mints exactly what the original map would have minted.
		restored.assign({
			clusterId: "entity:p1",
			kind: "person",
			aliases: ["J. Smith"],
			rulesetVersion: RULESET,
		});
		original.assign({
			clusterId: "entity:p1",
			kind: "person",
			aliases: ["J. Smith"],
			rulesetVersion: RULESET,
		});
		expect(restored.getCluster("entity:p1")?.pseudonym).toBe(
			original.getCluster("entity:p1")?.pseudonym,
		);
		restored.assign({
			clusterId: "entity:p2",
			kind: "person",
			aliases: ["Jane Doe"],
			rulesetVersion: RULESET,
		});
		original.assign({
			clusterId: "entity:p2",
			kind: "person",
			aliases: ["Jane Doe"],
			rulesetVersion: RULESET,
		});
		expect(restored.getCluster("entity:p2")?.pseudonym).toBe(
			original.getCluster("entity:p2")?.pseudonym,
		);
	});

	test("upsert is idempotent: no duplicate clusters, aliases, or identities", () => {
		const map = makeMap();
		const input = {
			clusterId: "entity:p1",
			kind: "person",
			aliases: ["John Smith", "john smith", "Johnny"],
			identities: [
				{ platform: "discord", handle: "jsmith" },
				{ platform: "Discord", handle: "JSMITH" },
			],
			evidence: ["seen in #general"],
			rulesetVersion: RULESET,
		};
		const first = map.assign(input);
		const second = map.assign(input);
		const third = map.assign(input);
		expect(map.size).toBe(1);
		expect(second.pseudonym).toBe(first.pseudonym);
		expect(third.aliases).toEqual(["John Smith", "Johnny"]);
		expect(third.identities).toEqual([
			{ platform: "discord", handle: "jsmith" },
		]);
		expect(third.evidence).toEqual(["seen in #general"]);
		expect(third.supersededPseudonyms).toEqual([]);
	});
});

describe("one person = one replacement everywhere (hard gate, map level)", () => {
	test("all four surface forms carry the SAME pseudonym; a similar-name second person gets a different one", () => {
		const map = makeMap();
		// One real person appearing as: full name (document), first name (second
		// document), nickname (chat), @handle (transcript mirror) — linked by the
		// entity backbone into ONE cluster.
		map.assign({
			clusterId: "entity:john",
			kind: "person",
			aliases: ["John Smith", "John", "Johnny", "@jsmith"],
			identities: [{ platform: "discord", handle: "jsmith" }],
			rulesetVersion: RULESET,
		});
		// A second, distinct person with a similar name — a different cluster.
		map.assign({
			clusterId: "entity:johnny-smythe",
			kind: "person",
			aliases: ["Jon Smythe"],
			rulesetVersion: RULESET,
		});

		const john = map.getCluster("entity:john");
		const smythe = map.getCluster("entity:johnny-smythe");
		if (!john || !smythe) throw new Error("clusters missing");
		expect(john.pseudonym).not.toBe(smythe.pseudonym);

		const artifacts = [
			"Contract addendum drafted by John Smith on behalf of the buyer.",
			"John reviewed the draft and approved it.",
			"chat: Johnny said he'd send the wire on Friday",
			"[transcript] @jsmith joined the call with Jon Smythe",
		];
		const rewritten = artifacts.map((a) => map.substituteAliases(a));

		// Zero alias occurrences survive, corpus-wide.
		for (const { text } of rewritten) {
			for (const alias of ["John Smith", "Johnny", "@jsmith", "Jon Smythe"]) {
				expect(text).not.toContain(alias);
			}
			// "John" standalone was unambiguous here (single cluster owns it).
			expect(/(?<![A-Za-z0-9_])John(?![A-Za-z0-9_])/.test(text)).toBe(false);
		}

		// Exactly one pseudonym per cluster, the same in every artifact.
		const johnMentions = rewritten.filter(({ text }) =>
			text.includes(john.pseudonym),
		);
		expect(johnMentions.length).toBe(4);
		expect(rewritten[3].text).toContain(smythe.pseudonym);

		// substitution is idempotent (re-running over scrubbed text is a no-op).
		const again = map.substituteAliases(rewritten[0].text);
		expect(again.text).toBe(rewritten[0].text);
	});

	test("assignment slices expose only {entityClusterId, surrogate, kind} — never a real alias", () => {
		const map = makeMap();
		map.assign({
			clusterId: "entity:p1",
			kind: "person",
			aliases: ["John Smith"],
			rulesetVersion: RULESET,
		});
		const assignment = map.assignmentFor("entity:p1");
		if (!assignment) throw new Error("assignment missing");
		expect(Object.keys(assignment).sort()).toEqual([
			"entityClusterId",
			"kind",
			"surrogate",
		]);
		expect(JSON.stringify(assignment)).not.toContain("John");
	});

	test("assignmentsForText returns only the clusters present in the chunk (never the whole map)", () => {
		const map = makeMap();
		map.assign({
			clusterId: "entity:p1",
			kind: "person",
			aliases: ["John Smith"],
			rulesetVersion: RULESET,
		});
		map.assign({
			clusterId: "entity:unrelated",
			kind: "person",
			aliases: ["Maria Curie"],
			rulesetVersion: RULESET,
		});
		const slice = map.assignmentsForText("Lunch with John Smith at noon");
		expect(slice.map((a) => a.entityClusterId)).toEqual(["entity:p1"]);
	});
});

describe("collision behavior", () => {
	test("an alias shared by two clusters is ambiguous: never substituted, both assignments surfaced", () => {
		const map = makeMap();
		map.assign({
			clusterId: "entity:john-a",
			kind: "person",
			aliases: ["John Smith", "John"],
			rulesetVersion: RULESET,
		});
		map.assign({
			clusterId: "entity:john-b",
			kind: "person",
			// The SAME full name — a second, distinct person.
			aliases: ["John Smith"],
			rulesetVersion: RULESET,
		});

		const a = map.getCluster("entity:john-a");
		const b = map.getCluster("entity:john-b");
		if (!a || !b) throw new Error("clusters missing");
		expect(a.pseudonym).not.toBe(b.pseudonym);
		expect(map.clustersForAlias("John Smith").length).toBe(2);

		// Blind substitution would link one person's history to the other; the
		// map refuses and reports the ambiguity for model escalation. The
		// ambiguous "John Smith" survives INTACT (no partial rewrite by the
		// contained, unambiguous "John"), while the standalone "John" — owned
		// only by cluster A — is still substituted.
		const result = map.substituteAliases("Meeting John Smith and John today");
		expect(result.text).toBe(`Meeting John Smith and ${a.pseudonym} today`);
		expect(result.ambiguous).toContain("John Smith");
		expect(result.applied.map((x) => x.entityClusterId)).toEqual([
			"entity:john-a",
		]);

		// The slice for the chunk carries BOTH candidate identities.
		const slice = map.assignmentsForText("Meeting John Smith today");
		expect(new Set(slice.map((s) => s.entityClusterId))).toEqual(
			new Set(["entity:john-a", "entity:john-b"]),
		);
	});

	test("a new REAL alias equal to an existing pseudonym re-mints that cluster with an audit trail", () => {
		const map = makeMap();
		const first = map.assign({
			clusterId: "entity:p1",
			kind: "person",
			aliases: ["Dana Whitfield"],
			rulesetVersion: RULESET,
		});
		// A real person turns out to have the same name as p1's minted pseudonym.
		map.assign({
			clusterId: "entity:p2",
			kind: "person",
			aliases: [first.pseudonym],
			rulesetVersion: RULESET,
		});
		const reminted = map.getCluster("entity:p1");
		if (!reminted) throw new Error("cluster missing");
		expect(reminted.pseudonym).not.toBe(first.pseudonym);
		expect(reminted.supersededPseudonyms).toEqual([first.pseudonym]);
		// The new person and the re-minted cluster remain distinct.
		expect(map.getCluster("entity:p2")?.pseudonym).not.toBe(reminted.pseudonym);
	});

	test("pseudonyms are unique across clusters and never equal any alias", () => {
		const map = makeMap();
		for (let i = 0; i < 60; i += 1) {
			map.assign({
				clusterId: `entity:p${i}`,
				kind: "person",
				aliases: [`Person Number${i}`],
				rulesetVersion: RULESET,
			});
		}
		const pseudonyms = map.records.map((r) => r.pseudonym.toLowerCase());
		expect(new Set(pseudonyms).size).toBe(pseudonyms.length);
		const aliasesLower = new Set(
			map.records.flatMap((r) => r.aliases.map((a) => a.toLowerCase())),
		);
		for (const pseudonym of pseudonyms) {
			expect(aliasesLower.has(pseudonym)).toBe(false);
		}
	});

	test("re-homing a platform identity to a second cluster throws (merge engine territory)", () => {
		const map = makeMap();
		map.assign({
			clusterId: "entity:p1",
			kind: "person",
			aliases: ["John Smith"],
			identities: [{ platform: "discord", handle: "jsmith" }],
			rulesetVersion: RULESET,
		});
		expect(() =>
			map.assign({
				clusterId: "entity:p2",
				kind: "person",
				aliases: ["Johnny S"],
				identities: [{ platform: "discord", handle: "jsmith" }],
				rulesetVersion: RULESET,
			}),
		).toThrow(PseudonymMapIntegrityError);
		// The rejected assign left the map untouched.
		expect(map.getCluster("entity:p2")).toBeUndefined();
		expect(map.size).toBe(1);
	});
});

describe("ruleset-version interaction with content-hash done-markers", () => {
	test("pseudonyms are STABLE across a ruleset bump while the done-marker key changes", () => {
		const map = makeMap();
		const before = map.assign({
			clusterId: "entity:p1",
			kind: "person",
			aliases: ["John Smith"],
			rulesetVersion: "2026.07",
		});
		const after = map.assign({
			clusterId: "entity:p1",
			kind: "person",
			aliases: ["John Smith"],
			rulesetVersion: "2026.08",
		});
		// Same person, same replacement — a ruleset bump must never re-link.
		expect(after.pseudonym).toBe(before.pseudonym);
		expect(after.rulesetVersion).toBe("2026.08");

		// But the content-hash marker layer DOES re-key, so unchanged content is
		// re-scrubbed under the new ruleset (with the same pseudonyms).
		const content = "Lunch with John Smith at noon";
		const keyV7 = scrubMarkerKeyForContent(content, "2026.07");
		const keyV8 = scrubMarkerKeyForContent(content, "2026.08");
		expect(keyV7).not.toBe(keyV8);
		// The rewritten content re-keys too: the scrubbed artifact is a new
		// content-address, never confused with the original's marker.
		const rewritten = map.substituteAliases(content).text;
		expect(scrubMarkerKeyForContent(rewritten, "2026.07")).not.toBe(keyV7);
	});

	test("assign without a rulesetVersion throws (marker layer would be version-collapsed)", () => {
		const map = makeMap();
		expect(() =>
			map.assign({
				clusterId: "entity:p1",
				kind: "person",
				aliases: ["John Smith"],
				rulesetVersion: "",
			}),
		).toThrow(PseudonymMapIntegrityError);
	});
});

describe("empty and adversarial input", () => {
	test("empty text and empty map are safe no-ops", () => {
		const map = makeMap();
		expect(map.substituteAliases("")).toEqual({
			text: "",
			applied: [],
			ambiguous: [],
		});
		expect(map.assignmentsForText("anything at all")).toEqual([]);
		map.assign({
			clusterId: "entity:p1",
			kind: "person",
			aliases: ["John Smith"],
			rulesetVersion: RULESET,
		});
		expect(map.substituteAliases("").text).toBe("");
		expect(map.assignmentsForText("")).toEqual([]);
	});

	test("whitespace, short, and blocklisted aliases are never indexed", () => {
		const map = makeMap();
		const record = map.assign({
			clusterId: "entity:p1",
			kind: "person",
			aliases: ["  ", "", "J", "eliza", "ELIZA", "John Smith"],
			rulesetVersion: RULESET,
		});
		expect(record.aliases).toEqual(["John Smith"]);
		// The framework's own name is never treated as an alias of a person.
		expect(map.substituteAliases("eliza helped John Smith").text).toContain(
			"eliza",
		);
	});

	test("empty clusterId throws", () => {
		const map = makeMap();
		expect(() =>
			map.assign({
				clusterId: "",
				kind: "person",
				aliases: ["John Smith"],
				rulesetVersion: RULESET,
			}),
		).toThrow(PseudonymMapIntegrityError);
	});

	test("aliases with regex metacharacters and unicode substitute exactly", () => {
		const map = makeMap();
		map.assign({
			clusterId: "entity:p1",
			kind: "person",
			aliases: ["John (Jack) Smith", "@j.smith+eng", "Jörg Müller"],
			rulesetVersion: RULESET,
		});
		const pseudonym = map.getCluster("entity:p1")?.pseudonym;
		if (!pseudonym) throw new Error("pseudonym missing");
		const result = map.substituteAliases(
			"John (Jack) Smith aka @j.smith+eng aka Jörg Müller",
		);
		expect(result.text).not.toContain("John (Jack) Smith");
		expect(result.text).not.toContain("@j.smith+eng");
		expect(result.text).not.toContain("Jörg Müller");
		expect(result.text.split(pseudonym).length - 1).toBe(3);
	});

	test("word boundaries: swapping an alias never mangles a containing word", () => {
		const map = makeMap();
		map.assign({
			clusterId: "entity:p1",
			kind: "person",
			aliases: ["John"],
			rulesetVersion: RULESET,
		});
		const result = map.substituteAliases("Johnson met John at Johnstown");
		expect(result.text).toContain("Johnson");
		expect(result.text).toContain("Johnstown");
		expect(/(?<![A-Za-z0-9_])John(?![A-Za-z0-9_])/.test(result.text)).toBe(
			false,
		);
	});
});

describe("snapshot validation is fail-closed", () => {
	function validSnapshot(): PseudonymMapSnapshot {
		const map = makeMap();
		map.assign({
			clusterId: "entity:p1",
			kind: "person",
			aliases: ["John Smith"],
			identities: [{ platform: "discord", handle: "jsmith" }],
			rulesetVersion: RULESET,
		});
		return map.toSnapshot();
	}

	test("accepts its own snapshots", () => {
		expect(() =>
			CorpusPseudonymMap.fromSnapshot(validSnapshot()),
		).not.toThrow();
	});

	test.each([
		["not an object", null],
		["wrong version", { ...validSnapshot(), version: 2 }],
		["missing salt", { ...validSnapshot(), salt: "" }],
		["clusters not an array", { ...validSnapshot(), clusters: {} }],
	] as const)("rejects %s", (_label, snapshot) => {
		expect(() =>
			CorpusPseudonymMap.fromSnapshot(snapshot as PseudonymMapSnapshot),
		).toThrow(PseudonymMapIntegrityError);
	});

	test("rejects duplicate clusters, shared pseudonyms, and shared identities", () => {
		const base = validSnapshot();
		const cluster = base.clusters[0];

		const dupCluster = {
			...base,
			clusters: [cluster, { ...cluster }],
		};
		expect(() => CorpusPseudonymMap.fromSnapshot(dupCluster)).toThrow(
			/duplicate cluster/,
		);

		const sharedPseudonym = {
			...base,
			clusters: [
				cluster,
				{ ...cluster, clusterId: "entity:p2", identities: [] },
			],
		};
		expect(() => CorpusPseudonymMap.fromSnapshot(sharedPseudonym)).toThrow(
			/no longer bijective/,
		);

		const sharedIdentity = {
			...base,
			clusters: [
				cluster,
				{ ...cluster, clusterId: "entity:p2", pseudonym: "Someone Else" },
			],
		};
		expect(() => CorpusPseudonymMap.fromSnapshot(sharedIdentity)).toThrow(
			/one identity = one person/,
		);
	});

	test("rejects a cluster missing its pseudonym or rulesetVersion", () => {
		const base = validSnapshot();
		const cluster = base.clusters[0];
		expect(() =>
			CorpusPseudonymMap.fromSnapshot({
				...base,
				clusters: [{ ...cluster, pseudonym: "" }],
			}),
		).toThrow(PseudonymMapIntegrityError);
		expect(() =>
			CorpusPseudonymMap.fromSnapshot({
				...base,
				clusters: [{ ...cluster, rulesetVersion: "" }],
			}),
		).toThrow(PseudonymMapIntegrityError);
	});
});
