/**
 * Covers `PseudonymSession`, the turn-scoped layer that swaps recognized PII
 * entities for deterministic surrogates before a model call and restores them
 * after — consistency, bijection, brand blocklist, recursive tool-arg and
 * boundary/prefix safety, and salt determinism vs unlinkability. Deterministic.
 */

import { describe, expect, it } from "vitest";
import {
	GazetteerEntityRecognizer,
	RegexEntityRecognizer,
} from "./entity-recognizer";
import {
	compileReplacer,
	DEFAULT_PSEUDONYM_BLOCKLIST,
	mintSurrogate,
	PseudonymSession,
} from "./pii-pseudonymizer";

/** Build a session whose recognizer knows a fixed contact roster. */
function sessionWith(
	entries: { kind: string; value: string }[],
	opts: Parameters<typeof PseudonymSession.prototype.constructor>[0] = {},
): PseudonymSession {
	return new PseudonymSession({
		salt: "fixed-test-salt",
		recognizer: new GazetteerEntityRecognizer(entries),
		...opts,
	});
}

describe("PseudonymSession", () => {
	it("swaps a person for a realistic, different surrogate and restores it", async () => {
		const s = sessionWith([{ kind: "person", value: "Dana Whitfield" }]);
		const text = "Please email Dana Whitfield about the contract.";
		await s.learn(text);
		const swapped = s.substituteText(text);

		expect(swapped).not.toContain("Dana Whitfield");
		// The surrogate is a plausible two-token name, not an opaque placeholder.
		expect(swapped).toMatch(/Please email [A-Z][a-z]+ [A-Z][a-z]+ about/);
		expect(swapped).not.toContain("__ELIZA");
		expect(s.restoreText(swapped)).toBe(text);
	});

	it("is consistent — the same value maps to the same surrogate everywhere", async () => {
		const s = sessionWith([{ kind: "person", value: "Dana Whitfield" }]);
		const text =
			"Dana Whitfield met Dana Whitfield's manager; ask Dana Whitfield.";
		await s.learn(text);
		const swapped = s.substituteText(text);
		const surrogate = s.entries[0]?.surrogate as string;
		expect([...swapped.matchAll(new RegExp(surrogate, "g"))]).toHaveLength(3);
		expect(s.restoreText(swapped)).toBe(text);
	});

	it("never swaps blocklisted framework/brand identity", async () => {
		const s = sessionWith([
			{ kind: "org", value: "elizaOS" },
			{ kind: "person", value: "Eliza" },
			{ kind: "org", value: "Anthropic" },
			{ kind: "org", value: "Acme Robotics" },
		]);
		const text = "elizaOS asked Eliza to call Anthropic for Acme Robotics.";
		await s.learn(text);
		const swapped = s.substituteText(text);

		expect(swapped).toContain("elizaOS");
		expect(swapped).toContain("Eliza");
		expect(swapped).toContain("Anthropic");
		// Only the genuine, non-blocklisted org is swapped.
		expect(swapped).not.toContain("Acme Robotics");
		expect(s.size).toBe(1);
		expect(s.restoreText(swapped)).toBe(text);
	});

	it("mints distinct surrogates for distinct values (bijection)", async () => {
		const roster = Array.from({ length: 50 }, (_, i) => ({
			kind: "person",
			value: `Contact Number${i}`,
		}));
		const s = sessionWith(roster);
		await s.learn(roster.map((r) => r.value).join("; "));
		const surrogates = s.entries.map((e) => e.surrogate);
		expect(new Set(surrogates).size).toBe(surrogates.length);
		expect(s.size).toBe(50);
	});

	it("is deterministic under a fixed salt and unlinkable under a random one", async () => {
		const roster = [{ kind: "person", value: "Dana Whitfield" }];
		const text = "call Dana Whitfield";

		const a = sessionWith(roster);
		const b = sessionWith(roster);
		await a.learn(text);
		await b.learn(text);
		expect(a.substituteText(text)).toBe(b.substituteText(text));

		// Different salts (default random) should generally yield different
		// surrogates — that unlinkability is the whole point across sessions.
		const salts = new Set<string>();
		for (let i = 0; i < 8; i += 1) {
			const c = new PseudonymSession({
				recognizer: new GazetteerEntityRecognizer(roster),
			});
			await c.learn(text);
			salts.add(c.entries[0]?.surrogate as string);
		}
		expect(salts.size).toBeGreaterThan(1);
	});

	it("substitutes structured values (tool-call args) recursively", async () => {
		const s = sessionWith([
			{ kind: "person", value: "Dana Whitfield" },
			{ kind: "org", value: "Northgate Union" },
		]);
		const payload = {
			action: "SEND_EMAIL",
			to: "Dana Whitfield",
			cc: ["Dana Whitfield", "someone-else"],
			body: { subject: "re: Northgate Union", note: "no PII here" },
		};
		await s.learn(JSON.stringify(payload));
		const swapped = s.substituteInValue(payload);

		expect(JSON.stringify(swapped)).not.toContain("Dana Whitfield");
		expect(JSON.stringify(swapped)).not.toContain("Northgate Union");
		// Structural shape is preserved; restore is the exact inverse.
		expect(s.restoreInValue(swapped)).toEqual(payload);
	});

	it("does not corrupt a benign word that a short name is a substring of", async () => {
		const s = sessionWith([{ kind: "person", value: "Sam" }]);
		const text = "Sam reviewed Samuel's samples in the Samsung samovar.";
		await s.learn(text);
		const swapped = s.substituteText(text);

		// "Sam" the person is swapped, but "Samuel", "samples", "Samsung",
		// "samovar" are untouched.
		expect(swapped).toContain("Samuel's samples");
		expect(swapped).toContain("Samsung samovar");
		expect(swapped).not.toMatch(/(?<![A-Za-z0-9_])Sam(?![A-Za-z0-9_])/);
		expect(s.restoreText(swapped)).toBe(text);
	});

	it("round-trips when a surrogate shares a token with another real value", async () => {
		// Force the adversarial case: many people whose surrogates are drawn from
		// the same name pool the real values could collide with.
		const roster = [
			{ kind: "person", value: "Priya" },
			{ kind: "person", value: "Mateo" },
			{ kind: "person", value: "Aria Okafor" },
			{ kind: "person", value: "Delgado" },
		];
		const s = sessionWith(roster);
		const text = "Priya and Mateo know Aria Okafor and Delgado well.";
		await s.learn(text);
		const swapped = s.substituteText(text);
		for (const r of roster) {
			expect(swapped).not.toMatch(
				new RegExp(`(?<![A-Za-z0-9_])${r.value}(?![A-Za-z0-9_])`),
			);
		}
		expect(s.restoreText(swapped)).toBe(text);
	});

	it("keeps genuine Elias Vargas distinct from the earlier Max Okafor surrogate", () => {
		const s = new PseudonymSession({ salt: "mc-0" });
		s.learnSpans("Max Okafor | Diego Castro", [
			{ kind: "person", value: "Max Okafor" },
			{ kind: "person", value: "Diego Castro" },
		]);
		const firstMaxWire = s.substituteText("Max Okafor");
		expect(firstMaxWire).toBe("Elias Vargas");

		s.learnSpans("Elias Vargas | Diego", [
			{ kind: "person", value: "Elias Vargas" },
			{ kind: "person", value: "Diego" },
		]);
		const text = "Max Okafor | Diego Castro | Elias Vargas | Diego";
		const swapped = s.substituteText(text);
		const max = s.entries.find((entry) => entry.value === "Max Okafor");
		const elias = s.entries.find((entry) => entry.value === "Elias Vargas");

		expect(max?.surrogate).not.toBe(firstMaxWire);
		expect(elias?.surrogate).toBeTruthy();
		expect(elias?.surrogate).not.toBe(max?.surrogate);
		expect(new Set(s.entries.map((entry) => entry.surrogate)).size).toBe(
			s.entries.length,
		);
		expect(s.restoreText(swapped)).toBe(text);
		expect(s.substituteText(swapped)).toBe(swapped);

		// A response already issued by the first call still belongs to Max. The
		// later genuine Elias passes through its current surrogate and restores to
		// Elias, so the same bytes are disambiguated by their model-call context.
		expect(s.restoreText(firstMaxWire)).toBe("Max Okafor");
		expect(s.restoreText(s.substituteText("Elias Vargas"))).toBe(
			"Elias Vargas",
		);

		// Repeated observations are stable and never rotate either entry again.
		const mappings = s.entries;
		s.learnSpans(text, [
			{ kind: "person", value: "Max Okafor" },
			{ kind: "person", value: "Elias Vargas" },
			{ kind: "person", value: "Elias Vargas" },
		]);
		expect(s.entries).toEqual(mappings);
	});

	it("uses an explicit mode to protect active surrogates during a substituted rescan", async () => {
		const s = sessionWith(
			[
				{ kind: "person", value: "Max Okafor" },
				{ kind: "person", value: "Elias Vargas" },
			],
			{ salt: "mc-0" },
		);
		await s.learn("Max Okafor");
		const substituted = s.substituteText("Max Okafor");
		const mapping = s.entries[0];

		await s.learn(substituted, { inputAlreadyPseudonymized: true });

		expect(s.entries).toEqual([mapping]);
		expect(s.substituteText(substituted)).toBe(substituted);
		expect(s.restoreText(substituted)).toBe("Max Okafor");

		// The provenance flag is call-scoped, not sticky. The same bytes arriving as
		// raw input on a later model call become their own real identity.
		await s.learn(substituted);
		expect(s.size).toBe(2);
		expect(s.restoreText(s.substituteText(substituted))).toBe("Elias Vargas");
		expect(s.restoreText(substituted)).toBe("Max Okafor");
	});

	it("still learns fresh hook text in substituted-rescan mode", () => {
		const s = new PseudonymSession({ salt: "mc-0" });
		s.learnSpans("Max Okafor", [{ kind: "person", value: "Max Okafor" }]);
		const maxWire = s.substituteText("Max Okafor");
		const postHookText = `${maxWire} asked New Person`;

		s.learnSpans(
			postHookText,
			[
				{ kind: "person", value: maxWire },
				{ kind: "person", value: "New Person" },
			],
			{ inputAlreadyPseudonymized: true },
		);

		expect(s.entries.map((entry) => entry.value)).toEqual([
			"Max Okafor",
			"New Person",
		]);
		expect(s.substituteText(postHookText)).not.toContain("New Person");
	});

	it("is collision-safe for either learn order and across entity kinds", () => {
		const run = (
			order: readonly { kind: string; value: string }[],
		): PseudonymSession => {
			const s = new PseudonymSession({ salt: "mc-0" });
			for (const entry of order) {
				s.learnSpans(entry.value, [entry]);
			}
			return s;
		};
		const max = { kind: "person", value: "Max Okafor" };
		const elias = { kind: "org", value: "Elias Vargas" };
		const text = `${max.value} | ${elias.value}`;

		for (const order of [
			[max, elias],
			[elias, max],
		] as const) {
			const first = run(order);
			const repeat = run(order);
			expect(first.restoreText(first.substituteText(text))).toBe(text);
			expect(
				first.entries.find((entry) => entry.value === elias.value)?.kind,
			).toBe("org");
			expect(first.entries).toEqual(repeat.entries);
			expect(new Set(first.entries.map((entry) => entry.surrogate)).size).toBe(
				2,
			);
		}
	});

	it("keeps collision rotations isolated to their owning session", () => {
		const a = new PseudonymSession({ salt: "mc-0" });
		const b = new PseudonymSession({ salt: "mc-0" });
		for (const s of [a, b]) {
			s.learnSpans("Max Okafor", [{ kind: "person", value: "Max Okafor" }]);
		}
		const sharedInitialWire = b.substituteText("Max Okafor");
		expect(sharedInitialWire).toBe("Elias Vargas");

		a.learnSpans("Elias Vargas", [{ kind: "location", value: "Elias Vargas" }]);

		expect(a.size).toBe(2);
		expect(b.size).toBe(1);
		expect(b.entries[0]?.surrogate).toBe(sharedInitialWire);
		expect(b.restoreText(sharedInitialWire)).toBe("Max Okafor");
	});

	it("pseudonymizes a regex-detected street address", async () => {
		const s = new PseudonymSession({
			salt: "fixed-test-salt",
			recognizer: new RegexEntityRecognizer(),
		});
		const text =
			"Ship it to 1600 Amphitheatre Parkway, Mountain View, CA 94043.";
		await s.learn(text);
		const swapped = s.substituteText(text);
		expect(swapped).not.toContain("1600 Amphitheatre Parkway");
		expect(s.entries[0]?.kind).toBe("address");
		expect(s.restoreText(swapped)).toBe(text);
	});

	it("exposes the framework brand blocklist for reuse", () => {
		expect(DEFAULT_PSEUDONYM_BLOCKLIST).toContain("elizaos");
		expect(DEFAULT_PSEUDONYM_BLOCKLIST).toContain("eliza");
	});

	it("honors disabledKinds (leave one class untouched)", async () => {
		const s = new PseudonymSession({
			salt: "fixed-test-salt",
			disabledKinds: ["location"],
			recognizer: new GazetteerEntityRecognizer([
				{ kind: "person", value: "Dana Whitfield" },
				{ kind: "location", value: "Rivertown" },
			]),
		});
		const text = "Dana Whitfield lives in Rivertown.";
		await s.learn(text);
		const swapped = s.substituteText(text);
		expect(swapped).toContain("Rivertown");
		expect(swapped).not.toContain("Dana Whitfield");
	});

	it("round-trips values containing regex-special characters and unicode", () => {
		const s = new PseudonymSession({ salt: "fixed-test-salt" });
		const text = "Ping José María at AT&T re: O'Brien & Sons (est. 1998).";
		s.learnSpans(text, [
			{ kind: "person", value: "José María" },
			{ kind: "org", value: "AT&T" },
			{ kind: "org", value: "O'Brien & Sons" },
		]);
		const swapped = s.substituteText(text);
		expect(swapped).not.toContain("José María");
		expect(swapped).not.toContain("AT&T");
		expect(swapped).not.toContain("O'Brien & Sons");
		// Exact inverse despite the +/&/'/( characters that would break a naive regex.
		expect(s.restoreText(swapped)).toBe(text);
	});

	it("does not corrupt a longer value that a shorter learned value is a prefix of", () => {
		const s = new PseudonymSession({ salt: "fixed-test-salt" });
		const text =
			"Compare Acme with Acme Robotics and Acme Robotics International.";
		s.learnSpans(text, [
			{ kind: "org", value: "Acme" },
			{ kind: "org", value: "Acme Robotics" },
			{ kind: "org", value: "Acme Robotics International" },
		]);
		const swapped = s.substituteText(text);
		expect(swapped).not.toMatch(/(?<![A-Za-z0-9_])Acme(?![A-Za-z0-9_])/);
		// Longest-first single pass keeps the three overlapping orgs distinct.
		expect(s.restoreText(swapped)).toBe(text);
		expect(new Set(s.entries.map((e) => e.surrogate)).size).toBe(3);
	});

	it("keeps two sessions independent (no shared surrogate vault)", async () => {
		const roster = [{ kind: "person", value: "Dana Whitfield" }];
		const a = new PseudonymSession({
			salt: "salt-a",
			recognizer: new GazetteerEntityRecognizer(roster),
		});
		const b = new PseudonymSession({
			salt: "salt-b",
			recognizer: new GazetteerEntityRecognizer(roster),
		});
		await a.learn("call Dana Whitfield");
		await b.learn("call Dana Whitfield");
		// Different salts ⇒ different surrogates (unlinkable), each restores only
		// against its own vault.
		expect(a.entries[0]?.surrogate).not.toBe(b.entries[0]?.surrogate);
		expect(a.restoreText(a.substituteText("call Dana Whitfield"))).toBe(
			"call Dana Whitfield",
		);
	});
});

// The corpus pseudonym map (#14805) reuses these two primitives directly rather
// than going through PseudonymSession, so they are asserted here against their
// exported contract: determinism, kind-shaping, collision-probe divergence, and
// the longest-first / word-boundary substitution guarantees.

describe("mintSurrogate", () => {
	it("is a pure function of (salt, kind, value, attempt)", () => {
		const first = mintSurrogate("s", "person", "Dana Whitfield", 0);
		const again = mintSurrogate("s", "person", "Dana Whitfield", 0);
		expect(again).toBe(first);
	});

	it("advances to a different surrogate as the collision-probe attempt increases", () => {
		// The caller bumps `attempt` on a collision; consecutive probes must not
		// keep minting the same candidate or the vault could never converge.
		const a0 = mintSurrogate("s", "person", "Dana Whitfield", 0);
		const a1 = mintSurrogate("s", "person", "Dana Whitfield", 1);
		const a2 = mintSurrogate("s", "person", "Dana Whitfield", 2);
		expect(new Set([a0, a1, a2]).size).toBe(3);
	});

	it("diverges across salts for the same value (cross-corpus unlinkability)", () => {
		const surrogates = new Set(
			Array.from({ length: 8 }, (_, i) =>
				mintSurrogate(`salt-${i}`, "person", "Dana Whitfield", 0),
			),
		);
		expect(surrogates.size).toBeGreaterThan(1);
	});

	it("shapes the surrogate to the entity kind", () => {
		expect(mintSurrogate("s", "person", "Dana Whitfield", 0)).toMatch(
			/^[A-Z][a-z]+ [A-Z][a-z]+$/,
		);
		expect(mintSurrogate("s", "org", "Northgate Union", 0)).toMatch(
			/^\S.* \S.*$/,
		);
		expect(mintSurrogate("s", "location", "Rivertown", 0)).not.toContain(" @");
		expect(mintSurrogate("s", "address", "1 Main St", 0)).toMatch(
			/^\d{3,4} .+$/,
		);
		// RFC 2606 reserved domain — a minted email can never route to a mailbox.
		expect(mintSurrogate("s", "email", "d@x.com", 0)).toMatch(
			/^[a-z]+\.[a-z]+@example\.com$/,
		);
		// NANP 555-01xx block is reserved for fictional use.
		expect(mintSurrogate("s", "phone", "+1 202 555 0100", 0)).toMatch(
			/^\(\d{3}\) 555-0\d{3}$/,
		);
	});

	it("falls back to a fluent person-shaped surrogate for an unknown kind", () => {
		// Unknown kinds must not leak an opaque token into otherwise-fluent text.
		expect(mintSurrogate("s", "spaceship", "USS Cerritos", 0)).toMatch(
			/^[A-Z][a-z]+ [A-Z][a-z]+$/,
		);
	});
});

describe("compileReplacer", () => {
	it("returns null when there is nothing to replace", () => {
		expect(compileReplacer([])).toBeNull();
	});

	it("matches the longest key first so an inserted value is never re-scanned", () => {
		const compiled = compileReplacer([
			{ from: "Acme", to: "Zeta" },
			{ from: "Acme Robotics", to: "Zeta Dynamics" },
		]);
		expect(compiled).not.toBeNull();
		const { regex, map } = compiled as {
			regex: RegExp;
			map: Map<string, string>;
		};
		const out = "Acme Robotics ships Acme parts".replace(
			regex,
			(m) => map.get(m) as string,
		);
		// Longest-first: "Acme Robotics" wins over the shorter "Acme" prefix, and
		// the standalone "Acme" is still swapped in the same single pass.
		expect(out).toBe("Zeta Dynamics ships Zeta parts");
	});

	it("only matches on word boundaries (never mangles a superstring)", () => {
		const compiled = compileReplacer([{ from: "John", to: "Marcus" }]);
		const { regex, map } = compiled as {
			regex: RegExp;
			map: Map<string, string>;
		};
		const out = "John met Johnson".replace(regex, (m) => map.get(m) as string);
		expect(out).toBe("Marcus met Johnson");
	});

	it("escapes regex-special characters in keys", () => {
		const compiled = compileReplacer([{ from: "AT&T", to: "Globex" }]);
		const { regex, map } = compiled as {
			regex: RegExp;
			map: Map<string, string>;
		};
		const out = "call AT&T today".replace(regex, (m) => map.get(m) as string);
		expect(out).toBe("call Globex today");
	});
});
