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
});
