import { describe, expect, test } from "vitest";
import { ChannelType } from "../../../types/primitives";
import { deleteSecretAction } from "./delete-secret";

function createRuntime(deleteResult: boolean) {
	return {
		agentId: "agent-1",
		getService: (name: string) => {
			if (name === "SECRETS") {
				return {
					delete: async () => deleteResult,
				};
			}
			return null;
		},
		getSetting: () => undefined,
		composeState: async () => ({}),
		dynamicPromptExecFromState: async () => ({}),
	};
}

describe("DELETE_SECRET", () => {
	test("deletes the secret in a DM channel", async () => {
		const result = await deleteSecretAction.handler(
			createRuntime(true) as never,
			{
				entityId: "user-1",
				roomId: "room-1",
				content: { text: "", channelType: ChannelType.DM },
			} as never,
			undefined,
			{ parameters: { key: "OPENAI_API_KEY" } } as never,
			async () => [],
		);

		expect(result.success).toBe(true);
		const data = result.data as { deleted: boolean };
		expect(data.deleted).toBe(true);
	});

	test("refuses to operate in non-DM channels", async () => {
		const result = await deleteSecretAction.handler(
			createRuntime(true) as never,
			{
				entityId: "user-1",
				roomId: "room-1",
				content: { text: "", channelType: ChannelType.GROUP },
			} as never,
			undefined,
			{ parameters: { key: "OPENAI_API_KEY" } } as never,
			async () => [],
		);

		expect(result.success).toBe(false);
		const data = result.data as { deleted: boolean };
		expect(data.deleted).toBe(false);
		expect(result.text).toMatch(/DM/i);
	});
});
