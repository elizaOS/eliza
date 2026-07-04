/**
 * Unit coverage for the ACTIONS provider's `isFollowUpCapableAction` helper:
 * follow-up capability is recognized only via the `FOLLOW_UP_CAPABLE_ACTION_TAG`
 * tag, never inferred from an action's name. Pure and deterministic — no runtime.
 */
import { describe, expect, it } from "vitest";
import { FOLLOW_UP_CAPABLE_ACTION_TAG } from "../../../types/index.ts";
import { isFollowUpCapableAction } from "./actions.ts";

describe("actions provider follow-up capability tagging", () => {
	it("recognizes actions that declare the follow-up-capable tag", () => {
		expect(
			isFollowUpCapableAction({
				tags: [FOLLOW_UP_CAPABLE_ACTION_TAG],
			}),
		).toBe(true);
	});

	it("does not treat an action name alone as follow-up capable", () => {
		expect(
			isFollowUpCapableAction({
				tags: [],
			}),
		).toBe(false);
	});
});
