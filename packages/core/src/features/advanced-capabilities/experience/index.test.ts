/**
 * Unit tests for the experience advanced-capability barrel (index.ts): every
 * runtime capability binding must survive re-export with its owning-module
 * identity, the eager bundle-safety anchor must publish exactly those bindings
 * under the barrel's unique globalThis key (the documented Bun.build
 * tree-shaking drop incident class), and the runtime const/enums re-exported
 * from ./types.ts must flow through unchanged.
 */
import { describe, expect, it } from "vitest";
import { manageExperienceAction as directManageExperienceAction } from "./actions/manage-experience.ts";
import { searchExperiencesAction as directSearchExperiencesAction } from "./actions/search-experiences.ts";
import { experiencePatternEvaluator as directExperiencePatternEvaluator } from "./evaluators/experience-items.ts";
import {
	ExperienceServiceType,
	ExperienceType,
	experiencePatternEvaluator,
	experienceProvider,
	manageExperienceAction,
	OutcomeType,
	searchExperiencesAction,
} from "./index.ts";
import { experienceProvider as directExperienceProvider } from "./providers/experienceProvider.ts";
import {
	ExperienceServiceType as directExperienceServiceType,
	ExperienceType as directExperienceType,
	OutcomeType as directOutcomeType,
} from "./types.ts";

const ANCHOR_KEY =
	"__bundle_safety_FEATURES_ADVANCED_CAPABILITIES_EXPERIENCE_INDEX__";

describe("experience feature barrel", () => {
	it("re-exports each runtime capability binding without dropping or shadowing it", () => {
		expect(manageExperienceAction).toBeDefined();
		expect(searchExperiencesAction).toBeDefined();
		expect(experiencePatternEvaluator).toBeDefined();
		expect(experienceProvider).toBeDefined();

		expect(manageExperienceAction).toBe(directManageExperienceAction);
		expect(searchExperiencesAction).toBe(directSearchExperiencesAction);
		expect(experiencePatternEvaluator).toBe(directExperiencePatternEvaluator);
		expect(experienceProvider).toBe(directExperienceProvider);
	});

	it("exposes the callable members consumers register and dispatch through", () => {
		expect(typeof manageExperienceAction.handler).toBe("function");
		expect(typeof searchExperiencesAction.handler).toBe("function");
		expect(typeof experiencePatternEvaluator.shouldRun).toBe("function");
		expect(typeof experiencePatternEvaluator.prepare).toBe("function");
		expect(typeof experienceProvider.get).toBe("function");
	});

	it("eagerly anchors its four bindings on globalThis in source order", () => {
		const anchored = (globalThis as Record<string, unknown>)[ANCHOR_KEY];
		expect(Array.isArray(anchored)).toBe(true);

		const bindings = anchored as readonly unknown[];
		expect(bindings).toHaveLength(4);
		expect(bindings[0]).toBe(manageExperienceAction);
		expect(bindings[1]).toBe(searchExperiencesAction);
		expect(bindings[2]).toBe(experiencePatternEvaluator);
		expect(bindings[3]).toBe(experienceProvider);
	});

	it("flows the service-type registration constant through export *", () => {
		expect(ExperienceServiceType).toBe(directExperienceServiceType);
		expect(ExperienceServiceType.EXPERIENCE).toBe("EXPERIENCE");
	});

	it("re-exports the ExperienceType and OutcomeType enums as live values", () => {
		expect(ExperienceType).toBe(directExperienceType);
		expect(OutcomeType).toBe(directOutcomeType);
		expect(ExperienceType.LEARNING).toBe("learning");
		expect(OutcomeType.MIXED).toBe("mixed");
	});
});
