/**
 * Deterministic unit tests for the basic-capabilities actions barrel. The real
 * module runs with no model, database, or transport mocks: every case asserts
 * the exported binding identities and the eager bundle-safety anchor that the
 * mobile build depends on.
 */
import { describe, expect, it } from "vitest";
import { choiceAction } from "./choice.ts";
import { ignoreAction } from "./ignore.ts";
import * as actionsIndex from "./index.ts";
import { noneAction } from "./none.ts";
import { replyAction } from "./reply.ts";

describe("basic-capabilities actions barrel", () => {
	it("binds every basic action under its canonical export name", () => {
		expect(Object.keys(actionsIndex).sort()).toEqual([
			"choiceAction",
			"ignoreAction",
			"noneAction",
			"replyAction",
		]);

		expect(actionsIndex.choiceAction).toBe(choiceAction);
		expect(actionsIndex.ignoreAction).toBe(ignoreAction);
		expect(actionsIndex.noneAction).toBe(noneAction);
		expect(actionsIndex.replyAction).toBe(replyAction);
	});

	it("exports live action objects carrying their dispatch names", () => {
		expect(actionsIndex.choiceAction.name).toBe("CHOOSE_OPTION");
		expect(actionsIndex.ignoreAction.name).toBe("IGNORE");
		expect(actionsIndex.noneAction.name).toBe("NONE");
		expect(actionsIndex.replyAction.name).toBe("REPLY");

		for (const action of [
			actionsIndex.choiceAction,
			actionsIndex.ignoreAction,
			actionsIndex.noneAction,
			actionsIndex.replyAction,
		]) {
			expect(action.description).toBeTruthy();
			expect(action.examples).toBeInstanceOf(Array);
		}
	});

	it("eagerly anchors the four action identities on globalThis at module init", () => {
		const anchor = (globalThis as Record<string, unknown>)
			.__bundle_safety_FEATURES_BASIC_CAPABILITIES_ACTIONS_INDEX__;

		expect(anchor).toEqual([
			choiceAction,
			ignoreAction,
			noneAction,
			replyAction,
		]);
	});
});
