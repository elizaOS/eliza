/**
 * Contract tests for the `PII_SCRUB` model-type seam (#14809).
 *
 * The failure contract IS the test: this seam is worth having only if it is
 * fail-closed. We prove:
 *
 *  - **Tier-0 short-circuit:** content whose sensitive spans are fully covered by
 *    the deterministic detectors makes ZERO model calls (call-count assertion).
 *  - **Fail-closed missing handler:** residue to escalate + no `PII_SCRUB`
 *    handler registered → throws (never passes un-inspected content as clean).
 *  - **Throw-never-fabricate:** a handler that throws propagates (item
 *    failed-for-retry); it is NEVER caught-and-defaulted to a clean verdict.
 *  - **Structural fabrication rejection:** a malformed / mismatched "all clear"
 *    result is rejected by `assertValidScrubResult`.
 *  - **Background priority:** the escalation call is issued at
 *    `priority: "background"` (never preempts interactive).
 *  - **Lane swap by registration only:** the same call-site runs green against
 *    two different handler registrations (local vs cloud) with no call-site
 *    change.
 */

import { describe, expect, it, vi } from "vitest";
import {
	ModelType,
	type PiiScrubParams,
	type PiiScrubResult,
} from "../types/model";
import type { IAgentRuntime } from "../types/runtime";
import {
	assertValidScrubResult,
	PiiScrubFabricationError,
	scrubWithEscalation,
} from "./pii-scrub-seam";

/**
 * Minimal fake runtime exposing only `getModel` / `useModel`. The handler, when
 * present, is a spy so we can assert call count and the params it received.
 */
function makeRuntime(handler?: {
	fn: (params: PiiScrubParams) => Promise<PiiScrubResult>;
}): { runtime: IAgentRuntime; useModel: ReturnType<typeof vi.fn> } {
	const useModel = vi.fn(
		async (_type: string, params: PiiScrubParams): Promise<PiiScrubResult> => {
			if (!handler) throw new Error("no handler");
			return handler.fn(params);
		},
	);
	const runtime = {
		getModel: (type: string) =>
			type === ModelType.PII_SCRUB && handler ? handler.fn : undefined,
		useModel,
	} as unknown as IAgentRuntime;
	return { runtime, useModel };
}

const RULESET = "v1";

describe("scrubWithEscalation — tier-0 escalation", () => {
	it("makes ZERO model calls when tier-0 covers every candidate", async () => {
		// A real credit card + SSN are structured PII the deterministic detectors
		// catch. Passing them as candidates must NOT escalate.
		const text = "card 4111111111111111 and ssn 219-09-9999 in this text";
		const { runtime, useModel } = makeRuntime();

		const result = await scrubWithEscalation(runtime, {
			text,
			candidateSpans: ["4111111111111111", "219-09-9999"],
			rulesetVersion: RULESET,
		});

		expect(useModel).not.toHaveBeenCalled();
		expect(result.escalated).toBe(false);
		expect(result.escalation).toBeNull();
		expect(result.tier0.map((s) => s.kind)).toContain("credit-card");
	});

	it("makes ZERO model calls when there are no candidates at all", async () => {
		const { runtime, useModel } = makeRuntime();
		const result = await scrubWithEscalation(runtime, {
			text: "nothing to see here",
			candidateSpans: [],
			rulesetVersion: RULESET,
		});
		expect(useModel).not.toHaveBeenCalled();
		expect(result.escalated).toBe(false);
	});

	it("escalates ONLY the residue candidates tier-0 could not decide", async () => {
		const text = "email me at a@b.com about Dana Whitfield at Acme";
		const handler = {
			fn: vi.fn(
				async (params: PiiScrubParams): Promise<PiiScrubResult> => ({
					verdicts: [
						{
							span: "Dana Whitfield",
							kind: "pii",
							replacement: "Priya Okafor",
						},
					],
					modelId: "local-gguf",
					rulesetVersion: params.rulesetVersion,
				}),
			),
		};
		const { runtime, useModel } = makeRuntime(handler);

		const result = await scrubWithEscalation(runtime, {
			text,
			// a@b.com is a tier-0 email; Dana Whitfield is the residue
			candidateSpans: ["a@b.com", "Dana Whitfield"],
			rulesetVersion: RULESET,
		});

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(
			(useModel.mock.calls[0][1] as PiiScrubParams).candidateSpans,
		).toEqual(["Dana Whitfield"]);
		expect(result.escalated).toBe(true);
		expect(result.escalation?.verdicts[0].replacement).toBe("Priya Okafor");
	});

	it("escalates a wider candidate that only partially overlaps tier-0", async () => {
		const text = "email a@b.com and Dana about the deal";
		const handler = {
			fn: vi.fn(
				async (params: PiiScrubParams): Promise<PiiScrubResult> => ({
					verdicts: [
						{
							span: params.candidateSpans[0] ?? "",
							kind: "pii",
							replacement: "[redacted]",
						},
					],
					modelId: "local-gguf",
					rulesetVersion: params.rulesetVersion,
				}),
			),
		};
		const { runtime, useModel } = makeRuntime(handler);

		await scrubWithEscalation(runtime, {
			text,
			candidateSpans: ["a@b.com and Dana"],
			rulesetVersion: RULESET,
		});

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(
			(useModel.mock.calls[0][1] as PiiScrubParams).candidateSpans,
		).toEqual(["a@b.com and Dana"]);
	});
});

describe("scrubWithEscalation — fail-closed doctrine", () => {
	it("throws when residue exists but NO PII_SCRUB handler is registered", async () => {
		const { runtime, useModel } = makeRuntime(); // no handler
		await expect(
			scrubWithEscalation(runtime, {
				text: "contact Dana Whitfield about the deal",
				candidateSpans: ["Dana Whitfield"],
				rulesetVersion: RULESET,
			}),
		).rejects.toBeInstanceOf(PiiScrubFabricationError);
		// And it must NOT have tried to fabricate a clean pass.
		expect(useModel).not.toHaveBeenCalled();
	});

	it("propagates a handler throw (never defaults to a clean verdict)", async () => {
		const boom = new Error("model unavailable");
		const handler = {
			fn: vi.fn(async (): Promise<PiiScrubResult> => {
				throw boom;
			}),
		};
		const { runtime } = makeRuntime(handler);
		await expect(
			scrubWithEscalation(runtime, {
				text: "contact Dana Whitfield about the deal",
				candidateSpans: ["Dana Whitfield"],
				rulesetVersion: RULESET,
			}),
		).rejects.toThrow("model unavailable");
	});

	it("rejects a fabricated all-clear that drops an escalated candidate", async () => {
		// Handler returns a well-formed but EMPTY verdict set — i.e. it silently
		// declared the residue clean by omission. Fail-closed must reject it.
		const handler = {
			fn: vi.fn(
				async (params: PiiScrubParams): Promise<PiiScrubResult> => ({
					verdicts: [],
					modelId: "local-gguf",
					rulesetVersion: params.rulesetVersion,
				}),
			),
		};
		const { runtime } = makeRuntime(handler);
		await expect(
			scrubWithEscalation(runtime, {
				text: "contact Dana Whitfield about the deal",
				candidateSpans: ["Dana Whitfield"],
				rulesetVersion: RULESET,
			}),
		).rejects.toBeInstanceOf(PiiScrubFabricationError);
	});

	it("rejects a result carrying a stale ruleset version", async () => {
		const handler = {
			fn: vi.fn(
				async (): Promise<PiiScrubResult> => ({
					verdicts: [{ span: "Dana Whitfield", kind: "pii", replacement: "X" }],
					modelId: "local-gguf",
					rulesetVersion: "v0-stale",
				}),
			),
		};
		const { runtime } = makeRuntime(handler);
		await expect(
			scrubWithEscalation(runtime, {
				text: "contact Dana Whitfield about the deal",
				candidateSpans: ["Dana Whitfield"],
				rulesetVersion: RULESET,
			}),
		).rejects.toBeInstanceOf(PiiScrubFabricationError);
	});
});

describe("scrubWithEscalation — background priority", () => {
	it("issues the escalation call at background priority by default", async () => {
		const handler = {
			fn: vi.fn(
				async (params: PiiScrubParams): Promise<PiiScrubResult> => ({
					verdicts: [
						{ span: "Dana Whitfield", kind: "pii", replacement: "Priya" },
					],
					modelId: "local-gguf",
					rulesetVersion: params.rulesetVersion,
				}),
			),
		};
		const { runtime, useModel } = makeRuntime(handler);
		await scrubWithEscalation(runtime, {
			text: "contact Dana Whitfield",
			candidateSpans: ["Dana Whitfield"],
			rulesetVersion: RULESET,
		});
		const params = useModel.mock.calls[0][1] as PiiScrubParams;
		expect(params.priority).toBe("background");
	});
});

describe("lane swap by registration only", () => {
	// The SAME request runs green against two different handlers (local GGUF vs
	// cloud) — the call-site is identical; only the registered handler differs.
	const request = {
		text: "contact Dana Whitfield about the deal",
		candidateSpans: ["Dana Whitfield"],
		rulesetVersion: RULESET,
	};

	it("runs against a local-GGUF handler", async () => {
		const { runtime } = makeRuntime({
			fn: async (params) => ({
				verdicts: [
					{ span: "Dana Whitfield", kind: "pii", replacement: "Priya Okafor" },
				],
				modelId: "eliza-privacy-gguf",
				rulesetVersion: params.rulesetVersion,
			}),
		});
		const result = await scrubWithEscalation(runtime, request);
		expect(result.escalation?.modelId).toBe("eliza-privacy-gguf");
	});

	it("runs against a cloud handler with ZERO call-site changes", async () => {
		const { runtime } = makeRuntime({
			fn: async (params) => ({
				verdicts: [
					{ span: "Dana Whitfield", kind: "pii", replacement: "Priya Okafor" },
				],
				modelId: "cerebras-cloud",
				rulesetVersion: params.rulesetVersion,
			}),
		});
		const result = await scrubWithEscalation(runtime, request);
		expect(result.escalation?.modelId).toBe("cerebras-cloud");
	});
});

describe("assertValidScrubResult — structural fail-closed", () => {
	const text = "contact Dana Whitfield at Acme";

	it("accepts a well-formed pii + safe result", () => {
		const good: PiiScrubResult = {
			verdicts: [
				{ span: "Dana Whitfield", kind: "pii", replacement: "Priya Okafor" },
				{ span: "Acme", kind: "safe" },
			],
			modelId: "m",
			rulesetVersion: RULESET,
		};
		expect(() =>
			assertValidScrubResult(good, { rulesetVersion: RULESET, text }),
		).not.toThrow();
	});

	it("rejects a non-object", () => {
		expect(() =>
			assertValidScrubResult(null, { rulesetVersion: RULESET, text }),
		).toThrow(PiiScrubFabricationError);
	});

	it("rejects a missing modelId", () => {
		expect(() =>
			assertValidScrubResult(
				{ verdicts: [], modelId: "", rulesetVersion: RULESET },
				{ rulesetVersion: RULESET, text },
			),
		).toThrow(/modelId/);
	});

	it("rejects a pii verdict with no replacement (fail-open)", () => {
		expect(() =>
			assertValidScrubResult(
				{
					verdicts: [{ span: "Dana Whitfield", kind: "pii" }],
					modelId: "m",
					rulesetVersion: RULESET,
				},
				{ rulesetVersion: RULESET, text },
			),
		).toThrow(/replacement/);
	});

	it("rejects a safe verdict that carries a replacement", () => {
		expect(() =>
			assertValidScrubResult(
				{
					verdicts: [{ span: "Acme", kind: "safe", replacement: "Northwind" }],
					modelId: "m",
					rulesetVersion: RULESET,
				},
				{ rulesetVersion: RULESET, text },
			),
		).toThrow(PiiScrubFabricationError);
	});

	it("rejects a verdict for a span not present in the text (hallucinated span)", () => {
		expect(() =>
			assertValidScrubResult(
				{
					verdicts: [
						{ span: "Bob Nonexistent", kind: "pii", replacement: "X" },
					],
					modelId: "m",
					rulesetVersion: RULESET,
				},
				{ rulesetVersion: RULESET, text },
			),
		).toThrow(/not present in the source text/);
	});

	it("rejects an unknown verdict kind", () => {
		expect(() =>
			assertValidScrubResult(
				{
					verdicts: [{ span: "Dana Whitfield", kind: "maybe" }],
					modelId: "m",
					rulesetVersion: RULESET,
				},
				{ rulesetVersion: RULESET, text },
			),
		).toThrow(/unknown kind/);
	});

	it("rejects when a required span received no verdict", () => {
		expect(() =>
			assertValidScrubResult(
				{
					verdicts: [{ span: "Acme", kind: "safe" }],
					modelId: "m",
					rulesetVersion: RULESET,
				},
				{
					rulesetVersion: RULESET,
					text,
					requiredSpans: ["Dana Whitfield"],
				},
			),
		).toThrow(/no verdict/);
	});

	it("rejects when only a narrower span received a verdict for a wider required span", () => {
		expect(() =>
			assertValidScrubResult(
				{
					verdicts: [{ span: "Dana", kind: "pii", replacement: "Priya" }],
					modelId: "m",
					rulesetVersion: RULESET,
				},
				{
					rulesetVersion: RULESET,
					text,
					requiredSpans: ["Dana Whitfield"],
				},
			),
		).toThrow(/no verdict/);
	});
});
