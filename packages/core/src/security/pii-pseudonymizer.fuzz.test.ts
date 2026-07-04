/**
 * Property-based fuzz over the PII pseudonymization layer (#10469 / #7007).
 * Seeded mulberry32 PRNG (fast-check v4 is unstable under Bun) so every run is
 * deterministic and reproducible. Each iteration builds a document that mixes
 * *real* named entities with benign filler — deliberately drawing real values
 * from the SAME name/word pools the surrogate generator uses, to stress the
 * hardest case: a minted surrogate that shares a token with another real value.
 *
 * Universal invariants the layer MUST uphold on every document:
 *   (P1) round-trip identity:  restore(substitute(doc)) === doc
 *   (P2) no-leak:              no learned real value survives as a token in
 *                              substitute(doc) — the provider never sees it
 *   (P3) bijection:            distinct real values → distinct surrogates
 *   (P4) idempotent:           substitute(substitute(doc)) === substitute(doc)
 *                              (originals are gone; surrogates are not re-swapped)
 *   (P5) deterministic:        same salt + same doc ⇒ identical output
 */

import { describe, expect, it } from "vitest";
import { GazetteerEntityRecognizer } from "./entity-recognizer";
import { PseudonymSession } from "./pii-pseudonymizer";

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const pick = <T>(rng: () => number, xs: readonly T[]): T =>
	xs[Math.floor(rng() * xs.length)] as T;
const randInt = (rng: () => number, lo: number, hi: number): number =>
	lo + Math.floor(rng() * (hi - lo + 1));

// Real-value pools that intentionally overlap the surrogate generator's pools.
const REAL_FIRST = [
	"Priya",
	"Mateo",
	"Aria",
	"Omar",
	"Lena",
	"Diego",
	"Nadia",
	"Elias",
	"Sam",
	"Jo",
	"Alex",
	"Dana",
	"Kai",
	"Max",
];
const REAL_LAST = [
	"Okafor",
	"Delgado",
	"Weber",
	"Sato",
	"Vargas",
	"Novak",
	"Rossi",
	"Whitfield",
	"Jensen",
	"Castro",
];
const REAL_ORG_HEAD = ["Northwind", "Summit", "Aurora", "Cascade", "Monarch"];
const REAL_ORG_TAIL = ["Labs", "Group", "Works", "Systems", "Partners"];
const REAL_CITY = ["Fairhaven", "Rivertown", "Oakdale", "Westmoor", "Ashford"];

const BENIGN = [
	"the",
	"please",
	"send",
	"to",
	"and",
	"about",
	"meeting",
	"note:",
	"status ok",
	"order 42",
	"v1.2.3",
	"\ntab\there",
	"emoji 🚀",
	"{ x: 1 }",
	"--flag",
	"Samuel",
	"Samsung",
	"grouping",
	"aurora borealis",
];

function genPerson(rng: () => number): string {
	if (rng() < 0.4) return pick(rng, REAL_FIRST);
	return `${pick(rng, REAL_FIRST)} ${pick(rng, REAL_LAST)}`;
}
function genOrg(rng: () => number): string {
	return `${pick(rng, REAL_ORG_HEAD)} ${pick(rng, REAL_ORG_TAIL)}`;
}
function genLocation(rng: () => number): string {
	return pick(rng, REAL_CITY);
}

/** Boundary-aware "does this real value survive as a token" probe. */
function survivesAsToken(haystack: string, value: string): boolean {
	const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(
		haystack,
	);
}

/**
 * Blank out every surrogate string (longest-first) so what remains is the model-
 * facing text with all *fake* names removed. A real value surviving in THIS masked
 * text is a genuine leak (an un-swapped real reference); a real value that only
 * appeared as a coincidental token *inside* a surrogate is correctly gone. This
 * matches the actual guarantee: a surrogate may share a token with (or equal)
 * another real name — it just must not be the original's own name, which the mint
 * enforces separately.
 */
function maskSurrogates(text: string, surrogates: readonly string[]): string {
	let masked = text;
	for (const s of [...surrogates].sort((a, b) => b.length - a.length)) {
		masked = masked.split(s).join("\0");
	}
	return masked;
}

describe("pii-pseudonymizer fuzz (seeded, 3000 iterations)", () => {
	it("upholds round-trip / no-leak / bijection / idempotent / deterministic", async () => {
		const rng = mulberry32(0x9953_1046);
		let totalEntities = 0;
		let docsWithEntities = 0;

		for (let iter = 0; iter < 3000; iter += 1) {
			// Assemble a distinct roster of real entities for this doc.
			const roster: { kind: string; value: string }[] = [];
			const seenValues = new Set<string>();
			const entityCount = randInt(rng, 0, 5);
			for (let e = 0; e < entityCount; e += 1) {
				const kind = pick(rng, ["person", "person", "org", "location"]);
				const value =
					kind === "person"
						? genPerson(rng)
						: kind === "org"
							? genOrg(rng)
							: genLocation(rng);
				if (seenValues.has(value)) continue;
				seenValues.add(value);
				roster.push({ kind, value });
			}

			// Interleave the entities with benign filler in random order.
			const parts: string[] = [];
			const slots = randInt(rng, 1, 10);
			const pool = [...roster.map((r) => r.value)];
			for (let sIdx = 0; sIdx < slots; sIdx += 1) {
				if (pool.length > 0 && rng() < 0.5) {
					// Emit a random remaining entity (may repeat later for consistency).
					parts.push(pick(rng, roster).value);
				} else {
					parts.push(pick(rng, BENIGN));
				}
			}
			// Ensure every rostered entity appears at least once so it is learnable.
			for (const r of roster) parts.push(r.value);
			const doc = parts.join(" ");

			const recognizer = new GazetteerEntityRecognizer(roster);
			const s = new PseudonymSession({
				salt: "fuzz-salt",
				recognizer,
			});
			await s.learn(doc);
			const swapped = s.substituteText(doc);

			totalEntities += s.size;
			if (s.size > 0) docsWithEntities += 1;

			// (P1) round-trip identity.
			expect(s.restoreText(swapped)).toBe(doc);

			// (P2) once the fake surrogates are masked out, no real value survives
			// as a token — every real reference the provider would see is a
			// surrogate, never the real entity. (A real name appearing only INSIDE a
			// surrogate is not a leak; the mint only guarantees surrogate != original.)
			const masked = maskSurrogates(
				swapped,
				s.entries.map((e) => e.surrogate),
			);
			for (const entry of s.entries) {
				expect(survivesAsToken(masked, entry.value)).toBe(false);
				// The one hard rule: a surrogate is never the original's own name.
				expect(entry.surrogate).not.toBe(entry.value);
			}

			// (P3) bijection: distinct values → distinct surrogates.
			const surrogates = s.entries.map((e) => e.surrogate);
			expect(new Set(surrogates).size).toBe(surrogates.length);

			// (P4) idempotent: re-substituting the swapped doc changes nothing and
			// restore still recovers the original.
			expect(s.substituteText(swapped)).toBe(swapped);
			expect(s.restoreText(s.substituteText(swapped))).toBe(doc);

			// (P5) deterministic: a fresh session, same salt + doc, same output.
			const s2 = new PseudonymSession({
				salt: "fuzz-salt",
				recognizer: new GazetteerEntityRecognizer(roster),
			});
			await s2.learn(doc);
			expect(s2.substituteText(doc)).toBe(swapped);
		}

		// Sanity: the fuzz actually exercised entities, not just benign text.
		expect(docsWithEntities).toBeGreaterThan(1500);
		expect(totalEntities).toBeGreaterThan(3000);
	});

	it("upholds round-trip + bijection under MULTI-CALL learn (cross-call surrogate/value collision)", async () => {
		// The runtime shares one turn session across model calls and calls learn()
		// once per call. A later call can introduce a real value equal to an earlier
		// call's minted surrogate — which must NOT collapse two people onto one
		// surrogate. Drive learn() many times, occasionally feeding a prior
		// surrogate back in as a brand-new real person, and assert the invariants.
		const rng = mulberry32(0x5eed_1069);
		let collisionsSeen = 0;
		for (let iter = 0; iter < 1500; iter += 1) {
			const s = new PseudonymSession({ salt: `mc-${iter % 7}` });
			const learned = new Set<string>();
			const calls = randInt(rng, 2, 6);
			for (let c = 0; c < calls; c += 1) {
				// Build this call's roster: some fresh people, and — to force the bug —
				// sometimes a person whose name equals an existing surrogate.
				const roster: { kind: string; value: string }[] = [];
				const existingSurrogates = s.entries.map((e) => e.surrogate);
				if (existingSurrogates.length > 0 && rng() < 0.6) {
					const collide = pick(rng, existingSurrogates);
					if (!learned.has(collide)) {
						roster.push({ kind: "person", value: collide });
						collisionsSeen += 1;
					}
				}
				const fresh = genPerson(rng);
				if (!learned.has(fresh)) roster.push({ kind: "person", value: fresh });
				for (const r of roster) learned.add(r.value);
				if (roster.length === 0) continue;

				const doc = roster.map((r) => r.value).join(" and ");
				s.learnSpans(
					doc,
					await new GazetteerEntityRecognizer(roster).recognize(doc),
				);

				// After every call, the full learned set must round-trip exactly and
				// no two real people may share a surrogate.
				const fullDoc = [...learned].join(" | ");
				const swapped = s.substituteText(fullDoc);
				expect(s.restoreText(swapped)).toBe(fullDoc);
				const surrogs = s.entries.map((e) => e.surrogate);
				expect(new Set(surrogs).size).toBe(surrogs.length);
				// Value and surrogate namespaces stay disjoint.
				const valueSet = new Set(s.entries.map((e) => e.value.toLowerCase()));
				for (const sur of surrogs) {
					expect(valueSet.has(sur.toLowerCase())).toBe(false);
				}
			}
		}
		// The fuzz actually exercised the collision path it targets.
		expect(collisionsSeen).toBeGreaterThan(200);
	});

	it("round-trips arbitrary random unicode (no spurious mangling, no learned entities)", async () => {
		const rng = mulberry32(0xbeef);
		for (let i = 0; i < 2000; i += 1) {
			const len = randInt(rng, 0, 60);
			let str = "";
			for (let c = 0; c < len; c += 1) {
				str += String.fromCharCode(randInt(rng, 32, 0x2fff));
			}
			// No recognizer ⇒ nothing learned ⇒ substitution/restoration are no-ops.
			const s = new PseudonymSession({ salt: "u" });
			expect(s.restoreText(s.substituteText(str))).toBe(str);
			expect(s.substituteText(str)).toBe(str);
		}
	});
});
