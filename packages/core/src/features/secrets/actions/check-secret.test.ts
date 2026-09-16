/**
 * Exercises `checkSecretHandler`, the SECRETS umbrella's `action=check` path,
 * which reports per-key presence and a missing list without ever returning
 * values, and fails when no keys are supplied. The runtime is a deterministic
 * stub whose `SECRETS` service returns canned `exists()` answers — no live
 * model or database.
 */

import { describe, expect, test } from "vitest";
import { ChannelType } from "../../../types/primitives";
import { checkSecretHandler } from "./check-secret";

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

describe("SECRETS action=check", () => {
	test("reports per-key presence and missing list", async () => {
		const result = await checkSecretHandler(
			createRuntime({
				OPENAI_API_KEY: true,
				ANTHROPIC_API_KEY: false,
			}) as never,
			createMessage() as never,
			undefined,
			{
				parameters: { key: ["openai-api-key", "ANTHROPIC_API_KEY"] },
			} as never,
			async () => [],
		);

		expect(result.success).toBe(true);
		const data = result.data as { present: boolean[]; missing: string[] };
		expect(data.present).toEqual([true, false]);
		expect(data.missing).toEqual(["ANTHROPIC_API_KEY"]);
	});

	test("fails when no keys are provided", async () => {
		const result = await checkSecretHandler(
			createRuntime({}) as never,
			createMessage() as never,
			undefined,
			{ parameters: {} } as never,
			async () => [],
		);

		expect(result.success).toBe(false);
		expect(result.text).toContain("key");
	});

	test("checks a single string key", async () => {
		const result = await checkSecretHandler(
			createRuntime({ SINGLE: true }) as never,
			createMessage() as never,
			undefined,
			{ parameters: { key: "single" } } as never,
		);
		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({ present: [true], missing: [] });
	});

	test("fails when the secrets service is unavailable", async () => {
		const result = await checkSecretHandler(
			{ ...createRuntime({}), getService: () => null } as never,
			createMessage() as never,
		);
		expect(result.success).toBe(false);
		expect(result.text).toBe("Secrets service not available");
	});
});
