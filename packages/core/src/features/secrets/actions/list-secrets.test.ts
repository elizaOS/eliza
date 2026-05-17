import { describe, expect, test } from "vitest";
import { ChannelType } from "../../../types/primitives";
import { listSecretsHandler } from "./list-secrets";

function createRuntime(metadata: Record<string, unknown>) {
	return {
		agentId: "agent-1",
		getService: (name: string) => {
			if (name === "SECRETS") {
				return {
					list: async () => metadata,
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

describe("SECRETS action=list", () => {
	test("returns keys + metadata, never values", async () => {
		const now = Date.now();
		const result = await listSecretsHandler(
			createRuntime({
				OPENAI_API_KEY: {
					status: "valid",
					createdAt: now - 1000,
					validatedAt: now - 500,
					expiresAt: now + 60_000,
				},
				ANTHROPIC_API_KEY: {
					status: "valid",
					createdAt: now - 2000,
					validatedAt: now - 1500,
				},
			}) as never,
			createMessage() as never,
			undefined,
			{ parameters: {} } as never,
			async () => [],
		);

		expect(result.success).toBe(true);
		const data = result.data as {
			keys: string[];
			metadata: Record<string, { setAt?: number; ttl?: number }>;
		};
		expect(data.keys).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
		expect(data.metadata.OPENAI_API_KEY.setAt).toBe(now - 1000);
		expect(typeof data.metadata.OPENAI_API_KEY.ttl).toBe("number");
		expect(data.metadata.ANTHROPIC_API_KEY.ttl).toBeUndefined();
		expect(JSON.stringify(data)).not.toContain("value");
	});

	test("filters by prefix when provided", async () => {
		const result = await listSecretsHandler(
			createRuntime({
				OPENAI_API_KEY: { status: "valid", createdAt: 1, validatedAt: 1 },
				ANTHROPIC_API_KEY: { status: "valid", createdAt: 1, validatedAt: 1 },
			}) as never,
			createMessage() as never,
			undefined,
			{ parameters: { prefix: "open" } } as never,
			async () => [],
		);

		const data = result.data as { keys: string[] };
		expect(data.keys).toEqual(["OPENAI_API_KEY"]);
	});
});
