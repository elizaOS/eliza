/**
 * Matrix for the Stage-1 context fallback resolver: unknown context ids are
 * dropped and reported; a tool-committed selection whose every non-simple id
 * was unknown falls back to `general` so the planner pipeline still runs
 * (live 2026-08-24 shape: contexts=["tasks"] + requiresTool=true where only
 * simple/general existed).
 */
import { describe, expect, it } from "vitest";
import {
	resolveStage1ContextFallback,
	STAGE1_FALLBACK_CONTEXT_ID,
} from "./stage1-context-fallback";

const AVAILABLE = ["simple", "general"];

describe("resolveStage1ContextFallback", () => {
	it("falls back to general for an all-unknown selection with requiresTool=true (live shape)", () => {
		const resolution = resolveStage1ContextFallback({
			selectedContexts: ["tasks"],
			availableContextIds: AVAILABLE,
			requiresTool: true,
			candidateActionCount: 1,
		});
		expect(resolution.contexts).toEqual([STAGE1_FALLBACK_CONTEXT_ID]);
		expect(resolution.droppedUnknownContexts).toEqual(["tasks"]);
		expect(resolution.fallbackApplied).toBe(true);
		expect(resolution.changed).toBe(true);
	});

	it("falls back to general when candidates exist and requiresTool is unstated", () => {
		const resolution = resolveStage1ContextFallback({
			selectedContexts: ["media"],
			availableContextIds: AVAILABLE,
			candidateActionCount: 2,
		});
		expect(resolution.contexts).toEqual(["general"]);
		expect(resolution.fallbackApplied).toBe(true);
	});

	it("drops the unknown id WITHOUT fallback when the plan committed to no tool work", () => {
		const resolution = resolveStage1ContextFallback({
			selectedContexts: ["simple", "made_up"],
			availableContextIds: AVAILABLE,
			requiresTool: false,
			candidateActionCount: 0,
		});
		expect(resolution.contexts).toEqual(["simple"]);
		expect(resolution.droppedUnknownContexts).toEqual(["made_up"]);
		expect(resolution.fallbackApplied).toBe(false);
		expect(resolution.changed).toBe(true);
	});

	it("keeps a known non-simple context and skips the fallback", () => {
		const resolution = resolveStage1ContextFallback({
			selectedContexts: ["general", "tasks"],
			availableContextIds: AVAILABLE,
			requiresTool: true,
			candidateActionCount: 1,
		});
		expect(resolution.contexts).toEqual(["general"]);
		expect(resolution.droppedUnknownContexts).toEqual(["tasks"]);
		expect(resolution.fallbackApplied).toBe(false);
	});

	it("treats simple as always-known even when not in the available list", () => {
		const resolution = resolveStage1ContextFallback({
			selectedContexts: ["simple", "tasks"],
			availableContextIds: ["general", "media"],
			requiresTool: true,
			candidateActionCount: 0,
		});
		expect(resolution.contexts).toEqual(["simple", "general"]);
		expect(resolution.droppedUnknownContexts).toEqual(["tasks"]);
		expect(resolution.fallbackApplied).toBe(true);
	});

	it("returns unchanged when every selected id is available", () => {
		const resolution = resolveStage1ContextFallback({
			selectedContexts: ["general"],
			availableContextIds: AVAILABLE,
			requiresTool: true,
			candidateActionCount: 0,
		});
		expect(resolution.changed).toBe(false);
		expect(resolution.contexts).toEqual(["general"]);
	});

	it("passes through when the available list is empty (availability unknown)", () => {
		const resolution = resolveStage1ContextFallback({
			selectedContexts: ["tasks"],
			availableContextIds: [],
			requiresTool: true,
			candidateActionCount: 1,
		});
		expect(resolution.changed).toBe(false);
		expect(resolution.contexts).toEqual(["tasks"]);
	});

	it("normalizes case/whitespace and dedupes both kept and dropped ids", () => {
		const resolution = resolveStage1ContextFallback({
			selectedContexts: [" General ", "TASKS", "tasks"],
			availableContextIds: AVAILABLE,
			requiresTool: true,
			candidateActionCount: 0,
		});
		expect(resolution.contexts).toEqual(["general"]);
		expect(resolution.droppedUnknownContexts).toEqual(["tasks"]);
	});

	it("does not duplicate general when the fallback target was already selected", () => {
		const resolution = resolveStage1ContextFallback({
			selectedContexts: ["general", "made_up"],
			availableContextIds: AVAILABLE,
			requiresTool: true,
			candidateActionCount: 0,
		});
		expect(resolution.contexts).toEqual(["general"]);
	});
});
