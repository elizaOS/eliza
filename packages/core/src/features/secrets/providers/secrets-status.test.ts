/**
 * Deterministic unit test for the SECRETS_INFO provider (features/secrets):
 * asserts it injects a type-grouped summary of configured secrets, stays
 * language-agnostic rather than gating its context on English secret keywords,
 * and returns empty text when the secrets service is unavailable. Runs against
 * a hand-built mock runtime — no live model or database.
 */
import { describe, expect, test } from "vitest";
import type { IAgentRuntime, Memory } from "../../../types/index.ts";
import {
	SECRETS_SERVICE_TYPE,
	type SecretsService,
} from "../services/secrets.ts";
import { secretsInfoProvider } from "./secrets-status.ts";

function runtimeWithSecrets(
	globalSecrets: Record<string, unknown>,
): IAgentRuntime {
	return {
		agentId: "agent-1",
		getService: (name: string) => {
			if (name === SECRETS_SERVICE_TYPE) {
				return {
					list: async () => globalSecrets,
				} satisfies Partial<SecretsService>;
			}
			return null;
		},
	} as unknown as IAgentRuntime;
}

function message(text: string): Memory {
	return {
		agentId: "agent-1",
		entityId: "user-1",
		roomId: "room-1",
		content: { text },
	} as Memory;
}

describe("SECRETS_INFO provider", () => {
	test("does not gate selected provider context on English secret keywords", async () => {
		const result = await secretsInfoProvider.get(
			runtimeWithSecrets({
				OPENAI_API_KEY: { status: "valid", type: "api_key" },
				DISCORD_BOT_TOKEN: { status: "valid", type: "bot_token" },
			}),
			message("configura mis credenciales"),
		);

		expect(result.text).toContain("[Secrets Info]");
		expect(result.text).toContain("Total configured secrets: 2");
		expect(result.text).toContain("api_key: OPENAI_API_KEY");
		expect(result.values).toEqual({ secretCount: 2 });
	});

	test("returns empty text only when the secrets service is unavailable", async () => {
		const result = await secretsInfoProvider.get(
			{ getService: () => null } as unknown as IAgentRuntime,
			message("secret status"),
		);

		expect(result).toEqual({ text: "" });
	});
});
