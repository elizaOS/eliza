/**
 * Runtime component contracts from `./components`: the action-mode taxonomy
 * that positions hooks in the message pipeline, the non-blocking
 * classification the dispatcher consults, and confirmation-status narrowing
 * used to pause action chains. Deterministic unit tests against the real
 * module — no mocks, no runtime instance.
 */

import { describe, expect, it } from "vitest";
import {
	ACTION_CONFIRMATION_STATUS_VALUES,
	ActionMode,
	FOLLOW_UP_CAPABLE_ACTION_TAG,
	HOOK_MODES,
	isActionConfirmationStatus,
	NON_BLOCKING_MODES,
} from "./components";

const CANONICAL_CONFIRMATION_STATUSES = [
	"CONFIRMATION_REQUIRED",
	"NOT_CONFIRMED",
	"REQUIRES_CONFIRMATION",
	"AWAITING_CONFIRMATION",
	"NEEDS_CONFIRMATION",
] as const;

describe("isActionConfirmationStatus", () => {
	it("accepts every canonical confirmation status", () => {
		for (const status of CANONICAL_CONFIRMATION_STATUSES) {
			expect(isActionConfirmationStatus(status)).toBe(true);
		}
	});

	it("accepts every member of the exported runtime set", () => {
		for (const status of ACTION_CONFIRMATION_STATUS_VALUES) {
			expect(isActionConfirmationStatus(status)).toBe(true);
		}
	});

	it("rejects non-string values", () => {
		const nonStrings: unknown[] = [
			undefined,
			null,
			42,
			0,
			true,
			false,
			{},
			["REQUIRES_CONFIRMATION"],
			Symbol("REQUIRES_CONFIRMATION"),
		];
		for (const value of nonStrings) {
			expect(isActionConfirmationStatus(value)).toBe(false);
		}
	});

	it("rejects strings that are not exact canonical statuses", () => {
		const nearMisses = [
			"",
			"confirmation_required",
			"requires_confirmation",
			"REQUIRES CONFIRMATION",
			" REQUIRES_CONFIRMATION",
			"REQUIRES_CONFIRMATION ",
			"CONFIRMATION",
			"NOT_CONFIRMED.",
		];
		for (const value of nearMisses) {
			expect(isActionConfirmationStatus(value)).toBe(false);
		}
	});
});

describe("ACTION_CONFIRMATION_STATUS_VALUES", () => {
	it("holds exactly the canonical statuses with no duplicates", () => {
		expect(ACTION_CONFIRMATION_STATUS_VALUES.size).toBe(
			CANONICAL_CONFIRMATION_STATUSES.length,
		);
		for (const status of CANONICAL_CONFIRMATION_STATUSES) {
			expect(ACTION_CONFIRMATION_STATUS_VALUES.has(status)).toBe(true);
		}
	});
});

describe("ActionMode", () => {
	it("maps every key to its identical canonical string value", () => {
		const entries = Object.entries(ActionMode) as Array<[string, ActionMode]>;
		for (const [key, value] of entries) {
			expect(key).toBe(value);
		}
	});

	it("declares ten unique modes spanning the scope-times-phase taxonomy plus PLANNER", () => {
		const values = Object.values(ActionMode);
		expect(values).toHaveLength(10);
		expect(new Set(values).size).toBe(values.length);
		const scopes = ["ALWAYS_", "CONTEXT_", "RESPONSE_HANDLER_"];
		const phases = ["BEFORE", "DURING", "AFTER"];
		for (const mode of values) {
			if (mode === "PLANNER") {
				continue;
			}
			const matchesTaxonomy = scopes.some((scope) =>
				phases.some((phase) => mode === `${scope}${phase}`),
			);
			expect(matchesTaxonomy).toBe(true);
		}
	});
});

describe("NON_BLOCKING_MODES", () => {
	it("classifies exactly the three *_DURING hooks as non-blocking", () => {
		expect(NON_BLOCKING_MODES.size).toBe(3);
		expect(NON_BLOCKING_MODES.has(ActionMode.ALWAYS_DURING)).toBe(true);
		expect(NON_BLOCKING_MODES.has(ActionMode.CONTEXT_DURING)).toBe(true);
		expect(NON_BLOCKING_MODES.has(ActionMode.RESPONSE_HANDLER_DURING)).toBe(
			true,
		);
	});

	it("leaves PLANNER and every BEFORE/AFTER hook blocking", () => {
		for (const mode of Object.values(ActionMode)) {
			if (mode.endsWith("_DURING")) {
				continue;
			}
			expect(NON_BLOCKING_MODES.has(mode)).toBe(false);
		}
	});
});

describe("HOOK_MODES", () => {
	it("covers every non-PLANNER mode exactly once", () => {
		expect(HOOK_MODES).toHaveLength(9);
		expect(new Set(HOOK_MODES).size).toBe(HOOK_MODES.length);
		expect(HOOK_MODES).not.toContain(ActionMode.PLANNER);
		for (const mode of Object.values(ActionMode)) {
			if (mode === ActionMode.PLANNER) {
				continue;
			}
			expect(HOOK_MODES).toContain(mode);
		}
	});

	it("opens the pipeline with the always-scope BEFORE hook", () => {
		expect(HOOK_MODES[0]).toBe(ActionMode.ALWAYS_BEFORE);
	});

	it("orders each scope's phases BEFORE, then DURING, then AFTER", () => {
		const order = (mode: ActionMode): number => {
			const at = HOOK_MODES.indexOf(mode);
			expect(at).toBeGreaterThanOrEqual(0);
			return at;
		};
		const scopes = ["ALWAYS_", "RESPONSE_HANDLER_", "CONTEXT_"] as const;
		for (const scope of scopes) {
			expect(order(`${scope}BEFORE` as ActionMode)).toBeLessThan(
				order(`${scope}DURING` as ActionMode),
			);
			expect(order(`${scope}DURING` as ActionMode)).toBeLessThan(
				order(`${scope}AFTER` as ActionMode),
			);
		}
	});
});

describe("FOLLOW_UP_CAPABLE_ACTION_TAG", () => {
	it("exposes a non-empty tag string usable in capability-tag checks", () => {
		expect(typeof FOLLOW_UP_CAPABLE_ACTION_TAG).toBe("string");
		expect(FOLLOW_UP_CAPABLE_ACTION_TAG.length).toBeGreaterThan(0);
	});
});
