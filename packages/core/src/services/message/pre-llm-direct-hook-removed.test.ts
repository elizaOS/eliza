/**
 * Regression test for #14715: core must not run extension hooks between the
 * direct shortcut gate and the planner/model path. LifeOps can still use
 * planner-selected MESSAGE actions plus SendPolicy/PgApprovalQueue, but a
 * pre-LLM direct-message hook must not be able to hijack ordinary chat turns.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SAMPLE_OWNER_TEXT =
	"I missed a call from mom — help me follow up, confirm?";

describe("message service pre-LLM direct hook removed (#14715)", () => {
	it("does not invoke runDirectMessageHooks before the planner/model path", () => {
		const messageServiceSource = readFileSync(
			join(process.cwd(), "src/services/message.ts"),
			"utf8",
		);

		expect(SAMPLE_OWNER_TEXT).toMatch(/missed a call/i);
		expect(messageServiceSource).not.toContain("runDirectMessageHooks");
		expect(messageServiceSource).not.toContain(
			"A pre-LLM direct-message hook handled this request.",
		);
	});
});
