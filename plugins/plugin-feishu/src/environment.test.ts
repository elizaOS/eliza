import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { getFeishuConfig, isChatAllowed, validateConfig } from "./environment";

function createRuntime(settings: Record<string, unknown>) {
	return Object.assign(Object.create(null) as IAgentRuntime, {
		getSetting: vi.fn((key: string) => settings[key]),
	});
}

describe("Feishu environment config", () => {
	it("fails closed when required app credentials are missing", () => {
		expect(getFeishuConfig(createRuntime({ FEISHU_APP_ID: "cli_test" }))).toBe(
			null,
		);
		expect(
			getFeishuConfig(createRuntime({ FEISHU_APP_SECRET: "secret" })),
		).toBe(null);
	});

	it("parses domain, booleans, and allowed chats while ignoring malformed allowlists", () => {
		const malformed = getFeishuConfig(
			createRuntime({
				FEISHU_APP_ID: "cli_test",
				FEISHU_APP_SECRET: "secret",
				FEISHU_ALLOWED_CHATS: "{not json",
				FEISHU_IGNORE_BOT_MESSAGES: "false",
				FEISHU_RESPOND_ONLY_TO_MENTIONS: "true",
				FEISHU_DOMAIN: "LARK",
			}),
		);

		expect(malformed).toEqual(
			expect.objectContaining({
				domain: "lark",
				apiRoot: "https://open.larksuite.com",
				allowedChatIds: [],
				shouldIgnoreBotMessages: false,
				shouldRespondOnlyToMentions: true,
			}),
		);
		if (!malformed) {
			throw new Error("expected malformed config fixture to resolve");
		}
		expect(isChatAllowed(malformed, "oc_any")).toBe(true);

		const allowlisted = getFeishuConfig(
			createRuntime({
				FEISHU_APP_ID: "cli_test",
				FEISHU_APP_SECRET: "secret",
				FEISHU_ALLOWED_CHATS: JSON.stringify(["oc_one", 2]),
			}),
		);

		expect(allowlisted?.allowedChatIds).toEqual(["oc_one", "2"]);
		if (!allowlisted) {
			throw new Error("expected allowlisted config fixture to resolve");
		}
		expect(isChatAllowed(allowlisted, "oc_one")).toBe(true);
		expect(isChatAllowed(allowlisted, "oc_other")).toBe(false);
	});

	it("rejects app IDs that do not use Feishu cli_ format", () => {
		expect(
			validateConfig({
				appId: "not_cli",
				appSecret: "secret",
				domain: "feishu",
				apiRoot: "https://open.feishu.cn",
				allowedChatIds: [],
				shouldIgnoreBotMessages: true,
				shouldRespondOnlyToMentions: false,
			}),
		).toEqual({
			valid: false,
			error: "FEISHU_APP_ID should start with 'cli_'",
		});
	});
});
