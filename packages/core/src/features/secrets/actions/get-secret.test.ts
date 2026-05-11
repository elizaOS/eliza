import { describe, expect, test } from "vitest";
import { ChannelType } from "../../../types/primitives";
import { getSecretAction } from "./get-secret";

interface ServiceOverrides {
	get?: (key: string) => Promise<string | null>;
}

function createRuntime(overrides: ServiceOverrides = {}) {
	return {
		agentId: "agent-1",
		getService: (name: string) => {
			if (name === "SECRETS") {
				return {
					get:
						overrides.get ?? (async () => "sk-abcdef12345678901234567890ABCD"),
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

describe("GET_SECRET", () => {
	test("returns the masked value by default", async () => {
		const result = await getSecretAction.handler(
			createRuntime() as never,
			createMessage() as never,
			undefined,
			{ parameters: { key: "OPENAI_API_KEY", mask: true } } as never,
			async () => [],
		);

		expect(result.success).toBe(true);
		const data = result.data as { value: string | null; masked: boolean };
		expect(data.value).not.toBeNull();
		expect(data.masked).toBe(true);
		expect(data.value).toContain("****");
	});

	test("reports null value when the secret is missing", async () => {
		const result = await getSecretAction.handler(
			createRuntime({ get: async () => null }) as never,
			createMessage() as never,
			undefined,
			{ parameters: { key: "MISSING_KEY", mask: true } } as never,
			async () => [],
		);

		expect(result.success).toBe(true);
		const data = result.data as { value: string | null; masked: boolean };
		expect(data.value).toBeNull();
		expect(data.masked).toBe(false);
	});

	test("fails when key parameter is missing", async () => {
		const result = await getSecretAction.handler(
			createRuntime() as never,
			createMessage() as never,
			undefined,
			{ parameters: {} } as never,
			async () => [],
		);

		expect(result.success).toBe(false);
		expect(result.text).toContain("key");
	});
});
