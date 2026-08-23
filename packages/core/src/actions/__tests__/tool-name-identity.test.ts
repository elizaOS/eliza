/**
 * Regression tests for planner-tool IDENTITY in `actions/to-tool`.
 *
 * A tool's identity is the exact string the model sends back as the tool name.
 * `buildPlannerToolsFromTieredActions` used the lenient hint key
 * (`UPPERCASE` with every non-alphanumeric character stripped) for BOTH
 * emission dedupe and string sub-action resolution, so two distinct registered
 * actions whose names differ only by separators — e.g. `GMAIL_CREATE_DRAFT`
 * and `GMAILCREATEDRAFT`, both legal under `NATIVE_TOOL_NAME_PATTERN` and
 * treated as distinct by `matchActionWildcardParts` — collapsed onto one key.
 * That silently dropped one of the pair from the planner surface and resolved
 * a sub-action reference to the wrong Action's schema.
 *
 * These tests also pin the lenient behaviour that must NOT regress: tier-A
 * parent matching stays separator/case-insensitive, and an UNAMBIGUOUS loose
 * sub-action reference still resolves.
 *
 * Deterministic — hand-built actions, no live model.
 */
import { describe, expect, it, vi } from "vitest";
import type { Action } from "../../types";
import { buildPlannerToolsFromTieredActions } from "../to-tool.ts";

function makeAction(overrides: Partial<Action>): Action {
	return {
		name: "TEST_ACTION",
		description: "Run the test action",
		parameters: [],
		handler: async () => undefined,
		validate: async () => true,
		...overrides,
	} as Action;
}

describe("planner tool identity", () => {
	it("emits both actions whose names differ only by separators", () => {
		const tools = buildPlannerToolsFromTieredActions([
			makeAction({
				name: "GMAIL_CREATE_DRAFT",
				description: "Create a Gmail draft.",
			}),
			makeAction({
				name: "GMAILCREATEDRAFT",
				description: "Legacy alias action with its own handler.",
			}),
		]);

		expect(tools.map((tool) => tool.name)).toEqual([
			"GMAIL_CREATE_DRAFT",
			"GMAILCREATEDRAFT",
		]);
	});

	it("still emits a genuinely duplicated action exactly once", () => {
		const tools = buildPlannerToolsFromTieredActions([
			makeAction({ name: "SEND_MESSAGE", description: "Send." }),
			makeAction({ name: "SEND_MESSAGE", description: "Send (again)." }),
		]);

		expect(tools.map((tool) => tool.name)).toEqual(["SEND_MESSAGE"]);
	});

	it("resolves a string sub-action reference to the exactly-named action", () => {
		const parent = makeAction({
			name: "MAILBOX",
			description: "Mailbox parent action.",
			subActions: ["GMAILCREATEDRAFT"],
		});

		const tools = buildPlannerToolsFromTieredActions([parent], {
			tierAParents: ["MAILBOX"],
			actionLookup: new Map([
				[
					"GMAIL_CREATE_DRAFT",
					makeAction({ name: "GMAIL_CREATE_DRAFT", description: "Canonical." }),
				],
				[
					"GMAILCREATEDRAFT",
					makeAction({ name: "GMAILCREATEDRAFT", description: "Legacy." }),
				],
			]),
		});

		expect(tools.map((tool) => tool.name)).toEqual([
			"MAILBOX",
			"GMAILCREATEDRAFT",
		]);
	});

	it("reports an AMBIGUOUS loose reference instead of guessing a twin", () => {
		const onUnresolved = vi.fn();
		const parent = makeAction({
			name: "MAILBOX",
			description: "Mailbox parent action.",
			subActions: ["gmail-create-draft"],
		});

		const tools = buildPlannerToolsFromTieredActions([parent], {
			tierAParents: ["MAILBOX"],
			actionLookup: new Map([
				[
					"GMAIL_CREATE_DRAFT",
					makeAction({ name: "GMAIL_CREATE_DRAFT", description: "Canonical." }),
				],
				[
					"GMAILCREATEDRAFT",
					makeAction({ name: "GMAILCREATEDRAFT", description: "Legacy." }),
				],
			]),
			onUnresolvedSubAction: onUnresolved,
		});

		expect(tools.map((tool) => tool.name)).toEqual(["MAILBOX"]);
		expect(onUnresolved).toHaveBeenCalledWith({
			parentName: "MAILBOX",
			subActionName: "gmail-create-draft",
		});
	});

	it("still resolves an UNAMBIGUOUS loose sub-action reference", () => {
		const parent = makeAction({
			name: "MUSIC",
			description: "Music parent action.",
			subActions: ["play-music"],
		});

		const tools = buildPlannerToolsFromTieredActions([parent], {
			tierAParents: ["MUSIC"],
			actionLookup: new Map([
				[
					"PLAY_MUSIC",
					makeAction({ name: "PLAY_MUSIC", description: "Play a track." }),
				],
			]),
		});

		expect(tools.map((tool) => tool.name)).toEqual(["MUSIC", "PLAY_MUSIC"]);
	});

	it("keeps tier-A parent matching separator/case-insensitive", () => {
		const parent = makeAction({
			name: "LIFE_OPS",
			description: "Life ops parent action.",
			subActions: [makeAction({ name: "CREATE_TASK", description: "Task." })],
		});

		const tools = buildPlannerToolsFromTieredActions([parent], {
			tierAParents: ["lifeops"],
		});

		expect(tools.map((tool) => tool.name)).toEqual(["LIFE_OPS", "CREATE_TASK"]);
	});
});
