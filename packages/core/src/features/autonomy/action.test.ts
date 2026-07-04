/**
 * Unit test for the autonomy capability's ESCALATE action, covering the
 * escalation targets it does not implement. Drives `escalateAction.handler`
 * directly with cast-empty runtime/memory (no model, no service), asserting that
 * `owner` and `third_party` targets fail with the `unsupported_escalation_target`
 * error code rather than silently succeeding.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory } from "../../types";
import { escalateAction } from "./action";

describe("escalateAction", () => {
	it.each([
		"owner",
		"third_party",
	] as const)("returns an unsupported-target result for %s escalation", async (action) => {
		const result = await escalateAction.handler(
			{} as IAgentRuntime,
			{} as Memory,
			undefined,
			{ parameters: { action } },
		);

		expect(result.success).toBe(false);
		expect(result.data).toMatchObject({
			actionName: "ESCALATE",
			action,
			errorCode: "unsupported_escalation_target",
		});
		expect(result.text).toContain("not supported");
	});
});
