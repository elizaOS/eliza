/** Covers the shared TTFA-budget knob both real Kokoro gates resolve through. Deterministic, env-injected. */
import { describe, expect, it } from "vitest";
import { KOKORO_MOBILE_TTFA_BUDGET_MS } from "../kokoro-backend";
import { resolveKokoroTtfaBudgetMs } from "../kokoro-ttfa-budget";

describe("resolveKokoroTtfaBudgetMs", () => {
	it("defaults to the mobile product budget when the knob is unset", () => {
		expect(resolveKokoroTtfaBudgetMs({})).toBe(KOKORO_MOBILE_TTFA_BUDGET_MS);
	});

	it("treats an empty or whitespace-only value as unset", () => {
		expect(resolveKokoroTtfaBudgetMs({ KOKORO_SMOKE_TTFA_BUDGET_MS: "" })).toBe(
			KOKORO_MOBILE_TTFA_BUDGET_MS,
		);
		expect(
			resolveKokoroTtfaBudgetMs({ KOKORO_SMOKE_TTFA_BUDGET_MS: "   " }),
		).toBe(KOKORO_MOBILE_TTFA_BUDGET_MS);
	});

	it("honors a positive integer override (the desktop-CPU CI ceiling)", () => {
		expect(
			resolveKokoroTtfaBudgetMs({ KOKORO_SMOKE_TTFA_BUDGET_MS: "30000" }),
		).toBe(30_000);
		expect(
			resolveKokoroTtfaBudgetMs({ KOKORO_SMOKE_TTFA_BUDGET_MS: " 1 " }),
		).toBe(1);
	});

	it("throws on a present-but-invalid value instead of gating silently", () => {
		for (const raw of ["0", "-5", "abc", "NaN"]) {
			expect(() =>
				resolveKokoroTtfaBudgetMs({ KOKORO_SMOKE_TTFA_BUDGET_MS: raw }),
			).toThrow(/positive integer/);
		}
	});

	it("reads process.env by default", () => {
		const prev = process.env.KOKORO_SMOKE_TTFA_BUDGET_MS;
		process.env.KOKORO_SMOKE_TTFA_BUDGET_MS = "12345";
		try {
			expect(resolveKokoroTtfaBudgetMs()).toBe(12_345);
		} finally {
			if (prev === undefined) {
				delete process.env.KOKORO_SMOKE_TTFA_BUDGET_MS;
			} else {
				process.env.KOKORO_SMOKE_TTFA_BUDGET_MS = prev;
			}
		}
	});
});
