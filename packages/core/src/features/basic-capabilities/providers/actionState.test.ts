import { describe, expect, it, vi } from "vitest";
import type {
	ActionResult,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types";
import { stringToUuid } from "../../../utils";
import { actionStateProvider } from "./actionState";

function result(index: number): ActionResult {
	return {
		success: true,
		text: `current-output-${index}`,
		data: { actionName: `CURRENT_ACTION_${index}` },
	};
}

describe("actionStateProvider", () => {
	it("keeps current-chain action results capped and separate from room history", async () => {
		const roomId = stringToUuid("room-1");
		const runtime = {
			getMemories: vi.fn(async () => [
				{
					id: stringToUuid("history-1"),
					roomId,
					entityId: stringToUuid("agent-1"),
					content: {
						type: "action_result",
						actionName: "OLD_ACTION",
						actionStatus: "completed",
						text: "old room output",
						runId: "old-run",
					},
					createdAt: 1,
				},
			]),
		} as unknown as IAgentRuntime;
		const message = {
			id: stringToUuid("message-1"),
			roomId,
			entityId: stringToUuid("user-1"),
			content: { text: "run actions" },
		} as Memory;
		const state = {
			values: {},
			data: {
				actionResults: Array.from({ length: 10 }, (_, index) =>
					result(index + 1),
				),
			},
			text: "",
		} as State;

		const providerResult = await actionStateProvider.get(
			runtime,
			message,
			state,
		);
		const currentResults = String(providerResult.values?.actionResults ?? "");

		expect(currentResults).toContain("(2 earlier action result(s) omitted.)");
		expect(currentResults).toContain("3. CURRENT_ACTION_3 - succeeded");
		expect(currentResults).toContain("10. CURRENT_ACTION_10 - succeeded");
		expect(currentResults).not.toContain("1. CURRENT_ACTION_1 - succeeded");
		expect(currentResults).not.toContain("OLD_ACTION");
		expect(providerResult.text).toContain("# Recent Action History");
		expect(providerResult.text).toContain("OLD_ACTION");
	});
});
