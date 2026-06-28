// Fuzz / hardening pass for the pure voice decision + validation helpers.
// validateVoiceScenario gates an arbitrary (possibly malformed) scenario object
// before the corpus build, and turnSignalFromProbability maps an arbitrary
// model probability (including NaN / +-Infinity) onto the speak/stay decision.
// Invariants under any input: never throw, and always return a value honoring
// the declared contract. A seeded LCG makes failures reproducible.

import { describe, expect, it } from "vitest";
import { clampProbability, turnSignalFromProbability } from "./eot-classifier";
import { type VoiceScenario, validateVoiceScenario } from "./voice-scenario";

function makeRng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

const KEYS = [
	"id",
	"classes",
	"participants",
	"turns",
	"agents",
	"environment",
	"label",
	"speaker",
	"text",
	"audioRef",
	"expectRespond",
	"expectEndOfTurn",
	"reverb",
	"farFieldDb",
];
const PRIMS = ["1", '"s"', "true", "false", "null", "-3.5", '""', '"alice"'];

function randomJson(rng: () => number, depth: number): string {
	if (depth <= 0 || rng() < 0.4) return PRIMS[Math.floor(rng() * PRIMS.length)];
	const k = 1 + Math.floor(rng() * 4);
	if (rng() < 0.5) {
		const items: string[] = [];
		for (let i = 0; i < k; i++) items.push(randomJson(rng, depth - 1));
		return `[${items.join(",")}]`;
	}
	const entries: string[] = [];
	for (let i = 0; i < k; i++) {
		const key = KEYS[Math.floor(rng() * KEYS.length)];
		entries.push(`${JSON.stringify(key)}:${randomJson(rng, depth - 1)}`);
	}
	return `{${entries.join(",")}}`;
}

describe("validateVoiceScenario - fuzz", () => {
	it("never throws and always returns a consistent {valid, errors} report", () => {
		const rng = makeRng(0x5ce4a);
		for (let i = 0; i < 3000; i++) {
			const value = JSON.parse(randomJson(rng, 4)) as unknown;
			const result = validateVoiceScenario(value as VoiceScenario);
			expect(typeof result.valid).toBe("boolean");
			expect(Array.isArray(result.errors)).toBe(true);
			for (const e of result.errors) expect(typeof e).toBe("string");
			// valid is exactly the no-errors case.
			expect(result.valid).toBe(result.errors.length === 0);
		}
	});
});

describe("turnSignalFromProbability / clampProbability - fuzz", () => {
	const EXTREMES = [
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		Number.MAX_VALUE,
		-Number.MAX_VALUE,
		0,
		1,
		-1,
		2,
		1e-12,
	];

	it("clampProbability always yields a finite value in [0,1]", () => {
		const rng = makeRng(0x110b);
		for (let i = 0; i < 3000; i++) {
			const p =
				rng() < 0.3
					? EXTREMES[Math.floor(rng() * EXTREMES.length)]
					: (rng() - 0.5) * 1e6;
			const c = clampProbability(p);
			expect(Number.isFinite(c)).toBe(true);
			expect(c).toBeGreaterThanOrEqual(0);
			expect(c).toBeLessThanOrEqual(1);
		}
	});

	it("turnSignalFromProbability always returns a well-formed signal", () => {
		const rng = makeRng(0xd00d);
		const speakers = new Set(["agent", "user", "unknown"]);
		for (let i = 0; i < 3000; i++) {
			const probability =
				rng() < 0.3
					? EXTREMES[Math.floor(rng() * EXTREMES.length)]
					: (rng() - 0.5) * 1e6;
			const sig = turnSignalFromProbability({
				probability,
				transcript: "x",
				source: "heuristic",
			});
			expect(speakers.has(sig.nextSpeaker)).toBe(true);
			expect(sig.endOfTurnProbability).toBeGreaterThanOrEqual(0);
			expect(sig.endOfTurnProbability).toBeLessThanOrEqual(1);
			expect([true, false, null]).toContain(sig.agentShouldSpeak);
		}
	});
});
