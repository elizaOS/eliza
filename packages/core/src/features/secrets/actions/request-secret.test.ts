import { describe, expect, test } from "vitest";
import { ChannelType } from "../../../types/primitives";
import { secretsAction } from "./manage-secret";
import { requestSecretHandler } from "./request-secret";

function createRuntime(settings: Record<string, unknown> = {}) {
	return {
		agentId: "agent-1",
		getService: (name: string) => {
			if (name === "SECRETS") {
				return {
					exists: async () => false,
				};
			}
			return null;
		},
		getSetting: (key: string) => settings[key],
		composeState: async () => ({}),
		dynamicPromptExecFromState: async () => ({}),
	};
}

describe("SECRETS action=request", () => {
	test("validates in public channels so it can route users to private entry", async () => {
		const ok = await secretsAction.validate?.(
			createRuntime() as never,
			{
				entityId: "user-1",
				roomId: "room-1",
				content: {
					text: "Need my OpenAI key",
					channelType: ChannelType.GROUP,
				},
			} as never,
			undefined,
			{
				parameters: { action: "request", key: "OPENAI_API_KEY" },
			} as never,
		);

		expect(ok).toBe(true);
	});

	test("does not ask for secret values in public chat", async () => {
		const callbacks: unknown[] = [];
		const result = await requestSecretHandler(
			createRuntime() as never,
			{
				entityId: "user-1",
				roomId: "room-1",
				content: {
					text: "Need my OpenAI key",
					channelType: ChannelType.GROUP,
				},
			} as never,
			undefined,
			{ parameters: { key: "OPENAI_API_KEY" } } as never,
			async (content) => {
				callbacks.push(content);
				return [];
			},
		);

		expect(result.success).toBe(true);
		expect(result.text).toContain("I cannot collect secrets in this channel");
		expect(result.text).not.toContain("set secret OPENAI_API_KEY");
		expect(JSON.stringify(callbacks)).toContain("dm_or_owner_app_instruction");
	});
});
