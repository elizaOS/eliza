import { describe, expect, it } from "vitest";
import {
	GazetteerEntityRecognizer,
	RegexEntityRecognizer,
} from "./entity-recognizer";
import {
	DEFAULT_PSEUDONYM_BLOCKLIST,
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
});
