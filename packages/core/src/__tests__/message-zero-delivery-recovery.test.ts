/**
 * Exercises the zero-terminal-delivery recovery contract with deterministic
 * action-result inputs. The harness distinguishes an early progress ack from a
 * terminal answer and covers success, failure, and delivered suppression.
 */
import { describe, expect, it } from "vitest";
import { FAILED_TOOL_FALLBACK_MESSAGE } from "../runtime/planner-loop";
import {
	resolveZeroDeliveryRecovery,
	type ZeroDeliveryRecovery,
} from "../services/message";

function recover(
	overrides: Partial<Parameters<typeof resolveZeroDeliveryRecovery>[0]> = {},
): ZeroDeliveryRecovery | null {
	return resolveZeroDeliveryRecovery({
		shouldSendPlannedText: false,
		earlyReplySent: false,
		deliveredVisibleTextCount: 0,
		actionResults: [],
		...overrides,
	});
}

describe("zero-terminal-delivery recovery", () => {
	it("stays inert when the normal planned reply will be sent", () => {
		expect(
			recover({
				shouldSendPlannedText: true,
				actionResults: [{ success: true, userFacingText: "Done." }],
			}),
		).toBeNull();
	});

	it("does not duplicate text already delivered by an action callback", () => {
		expect(
			recover({
				deliveredVisibleTextCount: 1,
				actionResults: [{ success: true, userFacingText: "Created it." }],
			}),
		).toBeNull();
	});

	it("treats an early ack as progress and recovers action-owned terminal text", () => {
		expect(
			recover({
				earlyReplySent: true,
				actionResults: [
					{ success: true, userFacingText: "The report is ready." },
				],
			}),
		).toEqual({
			text: "The report is ready.",
			source: "actionUserFacingText",
			hadEarlyReply: true,
			successfulActionCount: 1,
			failedActionCount: 0,
		});
	});

	it("uses the established honest failure fallback when every tool failed", () => {
		const result = recover({
			actionResults: [{ success: false }],
		});
		expect(result).toMatchObject({
			text: FAILED_TOOL_FALLBACK_MESSAGE,
			source: "failedToolFallback",
			successfulActionCount: 0,
			failedActionCount: 1,
		});
		expect(result?.text).not.toContain("finished working");
	});

	it("uses success wording only after a reported successful tool result", () => {
		const result = recover({
			actionResults: [{ success: true }],
		});
		expect(result).toMatchObject({
			source: "successfulToolFallback",
			successfulActionCount: 1,
			failedActionCount: 0,
		});
		expect(result?.text).toContain("completed the available step");
	});

	it("reports partial completion when successful and failed tools both lack text", () => {
		const result = recover({
			actionResults: [{ success: true }, { success: false }],
		});
		expect(result).toMatchObject({
			source: "partialToolFallback",
			successfulActionCount: 1,
			failedActionCount: 1,
		});
		expect(result?.text).toContain("completed part");
		expect(result?.text).toContain("another step failed");
	});
});
