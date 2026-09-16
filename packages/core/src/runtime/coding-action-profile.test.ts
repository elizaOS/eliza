/** Verifies per-turn coding profiles filter authorized actions without mutating the runtime catalog. */

import { describe, expect, it } from "vitest";
import { PI_CODING_ACTION_PROFILE } from "../types/coding";
import type { Action } from "../types/components";
import {
	applyCodingActionProfile,
	parseCodingActionProfile,
} from "./coding-action-profile";

function action(name: string): Action {
	return {
		name,
		description: name,
		examples: [],
		validate: async () => true,
		handler: async () => ({ success: true }),
	};
}

describe("applyCodingActionProfile", () => {
	it("keeps the complete authorized surface when no profile is selected", () => {
		const actions = [action("READ"), action("WEB_SEARCH")];

		expect(applyCodingActionProfile(actions, undefined)).toEqual(actions);
		expect(actions.map(({ name }) => name)).toEqual(["READ", "WEB_SEARCH"]);
	});

	it("uses Pi's action surface and makes WORKTREE explicitly configurable", () => {
		const actions = [
			action("FILE"),
			action("READ"),
			action("WRITE"),
			action("EDIT"),
			action("SHELL"),
			action("WORKTREE"),
			action("ATTACHMENT"),
			action("GENERATE_MEDIA"),
			action("WEB_FETCH"),
			action("WEB_SEARCH"),
		];

		expect(
			applyCodingActionProfile(actions, PI_CODING_ACTION_PROFILE).map(
				({ name }) => name,
			),
		).toEqual(["READ", "WRITE", "EDIT", "SHELL"]);
		expect(
			applyCodingActionProfile(actions, {
				kind: "pi",
				includeWorktree: true,
			}).map(({ name }) => name),
		).toEqual(["READ", "WRITE", "EDIT", "SHELL", "WORKTREE"]);
		expect(actions).toHaveLength(10);
	});

	it("can only narrow the actions that ordinary authorization already allowed", () => {
		const authorizedActions = [action("SHELL"), action("WEB_SEARCH")];

		expect(
			applyCodingActionProfile(authorizedActions, {
				kind: "pi",
				includeWorktree: true,
			}).map(({ name }) => name),
		).toEqual(["SHELL"]);
	});

	it.each([
		null,
		"pi",
		{},
		{ kind: "other" },
		{ kind: "pi", includeWorktree: "yes" },
		{ kind: "pi", includeWorktree: false, extra: true },
	])("rejects an invalid runtime profile shape: %j", (profile) => {
		expect(() => parseCodingActionProfile(profile)).toThrowError(
			expect.objectContaining({ code: "INVALID_CODING_ACTION_PROFILE" }),
		);
	});
});
