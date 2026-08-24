/**
 * Behavioral coverage for the setup state-machine helpers exported from
 * types/setup.ts: ordered step transitions at both sequence boundaries,
 * unknown-step handling, completion membership, and progress math that
 * excludes the COMPLETE marker from its denominator. Drives the real
 * module; no mocks stand in for the subject under test.
 */

import { describe, expect, test } from "vitest";
import {
	calculateProgress,
	getNextStep,
	getPreviousStep,
	getStepIndex,
	isStepCompleted,
	SETUP_STEP_ORDER,
	type SetupContext,
	SetupStep,
} from "./setup";

function makeContext(completedSteps: SetupStep[]): SetupContext {
	return {
		currentStep: SetupStep.WELCOME,
		completedSteps,
		settings: {},
		errors: [],
		startedAt: 0,
		lastActivityAt: 0,
		platform: "test",
		mode: "cli",
		sessionId: "session-1",
	};
}

describe("getStepIndex", () => {
	test("returns 0 for the first step and length - 1 for the terminal step", () => {
		expect(getStepIndex(SetupStep.WELCOME)).toBe(0);
		expect(getStepIndex(SetupStep.COMPLETE)).toBe(SETUP_STEP_ORDER.length - 1);
	});

	test("returns -1 for a step outside the sequence", () => {
		expect(getStepIndex("NOPE" as SetupStep)).toBe(-1);
	});
});

describe("getNextStep", () => {
	test("advances from the first step to the second", () => {
		expect(getNextStep(SetupStep.WELCOME)).toBe(SetupStep.RISK_ACK);
	});

	test("advances into COMPLETE from the last actionable step", () => {
		expect(getNextStep(SetupStep.SKILLS)).toBe(SetupStep.COMPLETE);
	});

	test("returns null at the end of the sequence", () => {
		expect(getNextStep(SetupStep.COMPLETE)).toBeNull();
	});

	test("returns null for an unknown step instead of advancing", () => {
		expect(getNextStep("NOPE" as SetupStep)).toBeNull();
	});
});

describe("getPreviousStep", () => {
	test("returns null at the beginning of the sequence", () => {
		expect(getPreviousStep(SetupStep.WELCOME)).toBeNull();
	});

	test("steps back one position from a middle step", () => {
		expect(getPreviousStep(SetupStep.RISK_ACK)).toBe(SetupStep.WELCOME);
	});

	test("steps back from COMPLETE to the last actionable step", () => {
		expect(getPreviousStep(SetupStep.COMPLETE)).toBe(SetupStep.SKILLS);
	});

	test("returns null for an unknown step instead of stepping back", () => {
		expect(getPreviousStep("NOPE" as SetupStep)).toBeNull();
	});
});

describe("walking the sequence via getNextStep", () => {
	test("a forward walk from WELCOME visits every step in order and stops at COMPLETE", () => {
		const walked: SetupStep[] = [];
		let cursor: SetupStep | null = SetupStep.WELCOME;
		while (cursor !== null) {
			walked.push(cursor);
			cursor = getNextStep(cursor);
		}
		expect(walked).toEqual([...SETUP_STEP_ORDER]);
		expect(walked[walked.length - 1]).toBe(SetupStep.COMPLETE);
	});

	test("walking backwards from COMPLETE reaches WELCOME without passing it", () => {
		const walked: SetupStep[] = [];
		let cursor: SetupStep | null = SetupStep.COMPLETE;
		while (cursor !== null) {
			walked.push(cursor);
			cursor = getPreviousStep(cursor);
		}
		expect(walked).toEqual([...SETUP_STEP_ORDER].reverse());
		expect(walked[walked.length - 1]).toBe(SetupStep.WELCOME);
	});
});

describe("isStepCompleted", () => {
	test("is false for every step on a fresh context", () => {
		for (const step of SETUP_STEP_ORDER) {
			expect(isStepCompleted(makeContext([]), step)).toBe(false);
		}
	});

	test("reports only steps recorded in completedSteps", () => {
		const context = makeContext([SetupStep.WELCOME, SetupStep.RISK_ACK]);
		expect(isStepCompleted(context, SetupStep.WELCOME)).toBe(true);
		expect(isStepCompleted(context, SetupStep.AUTH)).toBe(false);
	});
});

describe("calculateProgress", () => {
	test("an empty context reports 0 percent", () => {
		expect(calculateProgress(makeContext([]))).toBe(0);
	});

	test("every actionable step completed reports 100 percent", () => {
		const all = makeContext([
			SetupStep.WELCOME,
			SetupStep.RISK_ACK,
			SetupStep.AUTH,
			SetupStep.CHANNELS,
			SetupStep.SKILLS,
		]);
		expect(calculateProgress(all)).toBe(100);
	});

	test("partial completion is rounded to whole percents of the five actionable steps", () => {
		expect(
			calculateProgress(
				makeContext([SetupStep.WELCOME, SetupStep.RISK_ACK, SetupStep.AUTH]),
			),
		).toBe(60);
	});

	test("the COMPLETE marker does not inflate progress when present alone", () => {
		expect(calculateProgress(makeContext([SetupStep.COMPLETE]))).toBe(0);
	});

	test("the COMPLETE marker is excluded from the completed count alongside real steps", () => {
		expect(
			calculateProgress(makeContext([SetupStep.AUTH, SetupStep.COMPLETE])),
		).toBe(20);
	});

	test("duplicate entries each count toward the reported percentage", () => {
		expect(
			calculateProgress(makeContext([SetupStep.AUTH, SetupStep.AUTH])),
		).toBe(40);
	});
});
