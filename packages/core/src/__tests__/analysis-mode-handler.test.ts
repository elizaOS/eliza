import { afterEach, describe, expect, it } from "vitest";

import {
	__resetAnalysisModeFlagsForTests,
	appendAnalysisSidecar,
	isAnalysisModeAllowed,
	isAnalysisModeEnabledForRoom,
	maybeHandleAnalysisActivation,
	parseAnalysisToken,
} from "../services/analysis-mode-handler";

const ALLOW_ENV: NodeJS.ProcessEnv = { MILADY_ENABLE_ANALYSIS_MODE: "1" };
const DENY_ENV: NodeJS.ProcessEnv = { MILADY_ENABLE_ANALYSIS_MODE: "0" };

afterEach(() => {
	__resetAnalysisModeFlagsForTests();
});

describe("parseAnalysisToken (core mirror)", () => {
	it("matches the agent-side grammar", () => {
		expect(parseAnalysisToken("analysis")).toBe("enable");
		expect(parseAnalysisToken(" Analysis ")).toBe("enable");
		expect(parseAnalysisToken("as you were")).toBe("disable");
		expect(parseAnalysisToken("As You Were")).toBe("disable");
		expect(parseAnalysisToken("can you do an analysis?")).toBeNull();
		expect(parseAnalysisToken("")).toBeNull();
		expect(parseAnalysisToken(undefined)).toBeNull();
	});
});

describe("isAnalysisModeAllowed (core mirror)", () => {
	it("respects explicit env opt-in/out", () => {
		expect(isAnalysisModeAllowed({ MILADY_ENABLE_ANALYSIS_MODE: "1" })).toBe(
			true,
		);
		expect(isAnalysisModeAllowed({ MILADY_ENABLE_ANALYSIS_MODE: "0" })).toBe(
			false,
		);
		expect(
			isAnalysisModeAllowed({
				MILADY_ENABLE_ANALYSIS_MODE: "0",
				NODE_ENV: "development",
			}),
		).toBe(false);
	});

	it("falls through to NODE_ENV=development", () => {
		expect(isAnalysisModeAllowed({ NODE_ENV: "development" })).toBe(true);
		expect(isAnalysisModeAllowed({ NODE_ENV: "production" })).toBe(false);
		expect(isAnalysisModeAllowed({})).toBe(false);
	});
});

describe("maybeHandleAnalysisActivation", () => {
	it("returns handled:false when env gate is closed", () => {
		const result = maybeHandleAnalysisActivation(
			{ text: "analysis", roomId: "room-1" },
			DENY_ENV,
		);
		expect(result).toEqual({ handled: false });
		expect(isAnalysisModeEnabledForRoom("room-1")).toBe(false);
	});

	it("returns handled:false for normal messages even when allowed", () => {
		const result = maybeHandleAnalysisActivation(
			{ text: "hey what's up", roomId: "room-1" },
			ALLOW_ENV,
		);
		expect(result).toEqual({ handled: false });
		expect(isAnalysisModeEnabledForRoom("room-1")).toBe(false);
	});

	it("toggles the per-room flag on enable", () => {
		const result = maybeHandleAnalysisActivation(
			{ text: "analysis", roomId: "room-1" },
			ALLOW_ENV,
		);
		expect(result.handled).toBe(true);
		expect(result.enabledAfter).toBe(true);
		expect(typeof result.responseText).toBe("string");
		expect(result.responseText).toMatch(/analysis/i);
		expect(isAnalysisModeEnabledForRoom("room-1")).toBe(true);
	});

	it("toggles the per-room flag on disable", () => {
		maybeHandleAnalysisActivation(
			{ text: "analysis", roomId: "room-2" },
			ALLOW_ENV,
		);
		expect(isAnalysisModeEnabledForRoom("room-2")).toBe(true);

		const result = maybeHandleAnalysisActivation(
			{ text: "as you were", roomId: "room-2" },
			ALLOW_ENV,
		);
		expect(result.handled).toBe(true);
		expect(result.enabledAfter).toBe(false);
		expect(isAnalysisModeEnabledForRoom("room-2")).toBe(false);
	});

	it("scopes the flag per-room", () => {
		maybeHandleAnalysisActivation(
			{ text: "analysis", roomId: "room-a" },
			ALLOW_ENV,
		);
		expect(isAnalysisModeEnabledForRoom("room-a")).toBe(true);
		expect(isAnalysisModeEnabledForRoom("room-b")).toBe(false);
	});

	it("ignores non-token text inside otherwise-eligible activation flow", () => {
		// Sentence that *contains* "analysis" must not flip the flag.
		const result = maybeHandleAnalysisActivation(
			{ text: "give me an analysis of last quarter", roomId: "room-1" },
			ALLOW_ENV,
		);
		expect(result.handled).toBe(false);
		expect(isAnalysisModeEnabledForRoom("room-1")).toBe(false);
	});
});

describe("appendAnalysisSidecar", () => {
	it("returns the original text when no payload fields are present", () => {
		expect(appendAnalysisSidecar("hello", {})).toBe("hello");
	});

	it("renders the deterministic ANALYSIS block format", () => {
		const out = appendAnalysisSidecar("hi", {
			thoughtPreview: "thinking...",
			plannedActions: ["REPLY", "FOLLOW_UP"],
			simpleMode: false,
			evaluatorOutputs: ["FACT_EXTRACTOR"],
		});
		expect(out.startsWith("hi\n\n---\nANALYSIS:\n")).toBe(true);
		expect(out).toContain("thought: thinking...");
		expect(out).toContain("actions: REPLY, FOLLOW_UP");
		expect(out).toContain("simpleMode: false");
		expect(out).toContain("evaluators: FACT_EXTRACTOR");
	});
});
