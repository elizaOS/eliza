import { describe, expect, test } from "vitest";
import { ChannelType } from "../../../types/primitives";
import { checkSecretAction } from "./check-secret";

function createRuntime(present: Record<string, boolean>) {
	return {
		agentId: "agent-1",
		getService: (name: string) => {
			if (name === "SECRETS") {
				return {
					exists: async (key: string) => present[key] === true,
				};
			}
			return null;
		},
		getSetting: () => undefined,
		composeState: async () => ({}),
		dynamicPromptExecFromState: async () => ({}),
	};
}

function createMessage() {
	return {
		entityId: "user-1",
		roomId: "room-1",
		content: { text: "", channelType: ChannelType.DM },
	};
}

describe("CHECK_SECRET", () => {
	test("reports per-key presence and missing list", async () => {
		const result = await checkSecretAction.handler(
			createRuntime({
				OPENAI_API_KEY: true,
				ANTHROPIC_API_KEY: false,
			}) as never,
			createMessage() as never,
			undefined,
			{
				parameters: { key: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] },
			} as never,
			async () => [],
		);

		expect(result.success).toBe(true);
		const data = result.data as { present: boolean[]; missing: string[] };
		expect(data.present).toEqual([true, false]);
		expect(data.missing).toEqual(["ANTHROPIC_API_KEY"]);
	});

	test("fails when no keys are provided", async () => {
		const result = await checkSecretAction.handler(
			createRuntime({}) as never,
			createMessage() as never,
			undefined,
			{ parameters: {} } as never,
			async () => [],
		);

		expect(result.success).toBe(false);
		expect(result.text).toContain("key");
	});
});
