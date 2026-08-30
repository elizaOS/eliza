/**
 * Exercises the SECRETS umbrella's `action=request` path: `secretsAction.validate`
 * accepts public channels (so it can route the user elsewhere), while
 * `requestSecretHandler` refuses to collect secret values in public chat and
 * instead emits a DM/owner-app instruction. The runtime is a deterministic stub
 * whose `SECRETS` service reports the key absent — no live model or database.
 */

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

	test("falls back from a blank request base to the configured Cloud base", async () => {
		const callbacks: Array<Record<string, unknown>> = [];
		await requestSecretHandler(
			createRuntime({
				ELIZAOS_CLOUD_API_KEY: "cloud-key",
				ELIZAOS_CLOUD_ENABLED: "true",
				ELIZAOS_CLOUD_REQUEST_BASE_URL: "",
				ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/api/v1",
			}) as never,
			{
				entityId: "user-1",
				roomId: "room-1",
				content: {
					text: "Need my OpenAI key",
					channelType: ChannelType.DM,
					source: "telegram",
				},
			} as never,
			undefined,
			{ parameters: { key: "OPENAI_API_KEY" } } as never,
			async (content) => {
				callbacks.push(content as Record<string, unknown>);
				return [];
			},
		);

		const envelope = callbacks[0]?.content as {
			secretRequest?: {
				delivery?: { mode?: string; linkBaseUrl?: string };
			};
		};
		expect(envelope.secretRequest?.delivery).toMatchObject({
			mode: "cloud_authenticated_link",
			linkBaseUrl: "https://api-staging.eliza.app/api/v1",
		});
	});
});
