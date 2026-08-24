/**
 * Verifies analysis-mode activation, room isolation, and sidecar rendering
 * against the production handler with only environment inputs controlled.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	__resetAnalysisModeFlagsForTests,
	appendAnalysisSidecar,
	isAnalysisModeAllowed,
	isAnalysisModeEnabledForRoom,
	maybeHandleAnalysisActivation,
	parseAnalysisToken,
} from "../analysis-mode-handler.ts";

describe("parseAnalysisToken", () => {
	it("detects enable/disable tokens with whitespace tolerance", () => {
		expect(parseAnalysisToken("analysis")).toBe("enable");
		expect(parseAnalysisToken("  ANALYSIS  ")).toBe("enable");
		expect(parseAnalysisToken("as you were")).toBe("disable");
		expect(parseAnalysisToken("  AS YOU WERE ")).toBe("disable");
	});

	it("returns null for non-tokens and non-strings", () => {
		expect(parseAnalysisToken("analyze this")).toBeNull();
		expect(parseAnalysisToken("")).toBeNull();
		expect(parseAnalysisToken(undefined)).toBeNull();
		expect(parseAnalysisToken(null)).toBeNull();
	});

	it("tolerates tab and newline padding around tokens", () => {
		expect(parseAnalysisToken("\tanalysis\n")).toBe("enable");
		expect(parseAnalysisToken("as\tyou\twere")).toBe("disable");
	});

	it("rejects near-miss tokens", () => {
		expect(parseAnalysisToken("analysis!")).toBeNull();
		expect(parseAnalysisToken("asyouwere")).toBeNull();
		expect(parseAnalysisToken("as-you-were")).toBeNull();
	});
});

describe("isAnalysisModeAllowed", () => {
	it("honors the explicit env gate", () => {
		expect(isAnalysisModeAllowed({ ELIZA_ENABLE_ANALYSIS_MODE: "1" })).toBe(
			true,
		);
		expect(isAnalysisModeAllowed({ ELIZA_ENABLE_ANALYSIS_MODE: "0" })).toBe(
			false,
		);
	});

	it("falls back to NODE_ENV development", () => {
		expect(isAnalysisModeAllowed({ NODE_ENV: "development" })).toBe(true);
		expect(isAnalysisModeAllowed({ NODE_ENV: "production" })).toBe(false);
		expect(isAnalysisModeAllowed({})).toBe(false);
	});

	it("lets an explicit opt-out override NODE_ENV=development", () => {
		expect(
			isAnalysisModeAllowed({
				ELIZA_ENABLE_ANALYSIS_MODE: "0",
				NODE_ENV: "development",
			}),
		).toBe(false);
	});

	it("treats values other than 0 and 1 as unset", () => {
		expect(isAnalysisModeAllowed({ ELIZA_ENABLE_ANALYSIS_MODE: "true" })).toBe(
			false,
		);
		expect(
			isAnalysisModeAllowed({
				ELIZA_ENABLE_ANALYSIS_MODE: "true",
				NODE_ENV: "development",
			}),
		).toBe(true);
	});
});

describe("maybeHandleAnalysisActivation", () => {
	beforeEach(() => __resetAnalysisModeFlagsForTests());
	afterEach(() => __resetAnalysisModeFlagsForTests());
	const env = { ELIZA_ENABLE_ANALYSIS_MODE: "1" };

	it("enables analysis mode for a room", () => {
		const result = maybeHandleAnalysisActivation(
			{ text: "analysis", roomId: "r1" },
			env,
		);
		expect(result.handled).toBe(true);
		expect(result.enabledAfter).toBe(true);
		expect(result.responseText).toContain("on");
		expect(isAnalysisModeEnabledForRoom("r1")).toBe(true);
	});

	it("disables analysis mode for a room", () => {
		maybeHandleAnalysisActivation({ text: "analysis", roomId: "r1" }, env);
		const result = maybeHandleAnalysisActivation(
			{ text: "as you were", roomId: "r1" },
			env,
		);
		expect(result.handled).toBe(true);
		expect(result.enabledAfter).toBe(false);
		expect(isAnalysisModeEnabledForRoom("r1")).toBe(false);
	});

	it("flags are per-room", () => {
		maybeHandleAnalysisActivation({ text: "analysis", roomId: "r1" }, env);
		expect(isAnalysisModeEnabledForRoom("r1")).toBe(true);
		expect(isAnalysisModeEnabledForRoom("r2")).toBe(false);
	});

	it("ignores non-token text", () => {
		const result = maybeHandleAnalysisActivation(
			{ text: "hello there", roomId: "r1" },
			env,
		);
		expect(result.handled).toBe(false);
	});

	it("ignores activation when the env gate is closed", () => {
		const result = maybeHandleAnalysisActivation(
			{ text: "analysis", roomId: "r1" },
			{ NODE_ENV: "production" },
		);
		expect(result.handled).toBe(false);
		expect(isAnalysisModeEnabledForRoom("r1")).toBe(false);
	});

	it("emits exact confirmation text for both directions", () => {
		expect(
			maybeHandleAnalysisActivation({ text: "analysis", roomId: "r1" }, env)
				.responseText,
		).toBe("Analysis mode on.");
		expect(
			maybeHandleAnalysisActivation({ text: "as you were", roomId: "r1" }, env)
				.responseText,
		).toBe("Analysis mode off.");
	});

	it("handles as you were for a room that was never enabled", () => {
		const result = maybeHandleAnalysisActivation(
			{ text: "as you were", roomId: "never-on" },
			env,
		);
		expect(result.handled).toBe(true);
		expect(result.enabledAfter).toBe(false);
		expect(result.responseText).toBe("Analysis mode off.");
		expect(isAnalysisModeEnabledForRoom("never-on")).toBe(false);
	});

	it("re-enables a room after a disable cycle", () => {
		maybeHandleAnalysisActivation({ text: "analysis", roomId: "r1" }, env);
		maybeHandleAnalysisActivation({ text: "as you were", roomId: "r1" }, env);
		expect(isAnalysisModeEnabledForRoom("r1")).toBe(false);
		const result = maybeHandleAnalysisActivation(
			{ text: "ANALYSIS", roomId: "r1" },
			env,
		);
		expect(result.enabledAfter).toBe(true);
		expect(isAnalysisModeEnabledForRoom("r1")).toBe(true);
	});

	it("reads process.env when no env argument is passed", () => {
		const previous = process.env.ELIZA_ENABLE_ANALYSIS_MODE;
		process.env.ELIZA_ENABLE_ANALYSIS_MODE = "1";
		try {
			const result = maybeHandleAnalysisActivation({
				text: "analysis",
				roomId: "env-default",
			});
			expect(result.handled).toBe(true);
			expect(isAnalysisModeEnabledForRoom("env-default")).toBe(true);
		} finally {
			if (previous === undefined) {
				delete process.env.ELIZA_ENABLE_ANALYSIS_MODE;
			} else {
				process.env.ELIZA_ENABLE_ANALYSIS_MODE = previous;
			}
		}
	});
});

describe("appendAnalysisSidecar", () => {
	it("appends formatted debug lines", () => {
		const out = appendAnalysisSidecar("Reply", {
			thoughtPreview: "think",
			plannedActions: ["a1", "a2"],
			simpleMode: true,
		});
		expect(out).toContain("Reply");
		expect(out).toContain("ANALYSIS:");
		expect(out).toContain("thought: think");
		expect(out).toContain("actions: a1, a2");
		expect(out).toContain("simpleMode: true");
	});

	it("returns text unchanged when no payload fields present", () => {
		expect(appendAnalysisSidecar("Reply", {})).toBe("Reply");
	});

	it("appends evaluator outputs and keeps section order deterministic", () => {
		const out = appendAnalysisSidecar("Reply", {
			thoughtPreview: "think",
			plannedActions: ["a1"],
			simpleMode: false,
			evaluatorOutputs: ["e1", "e2"],
		});
		expect(out).toContain("evaluators: e1, e2");
		expect(out.indexOf("thought:")).toBeLessThan(out.indexOf("actions:"));
		expect(out.indexOf("actions:")).toBeLessThan(out.indexOf("simpleMode:"));
		expect(out.indexOf("simpleMode:")).toBeLessThan(out.indexOf("evaluators:"));
	});

	it("renders simpleMode false when explicitly set", () => {
		expect(appendAnalysisSidecar("Reply", { simpleMode: false })).toContain(
			"simpleMode: false",
		);
	});

	it("uses the exact deterministic delimiter format", () => {
		expect(appendAnalysisSidecar("R", { plannedActions: [] })).toBe(
			"R\n\n---\nANALYSIS:\nactions: ",
		);
	});

	it("ignores fields of the wrong runtime type", () => {
		const out = appendAnalysisSidecar("Reply", {
			thoughtPreview: 42 as unknown as string,
			plannedActions: "a1" as unknown as readonly string[],
		});
		expect(out).toBe("Reply");
	});
});
