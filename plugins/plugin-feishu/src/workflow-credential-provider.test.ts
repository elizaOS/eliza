/**
 * Tests FeishuWorkflowCredentialProvider — that it returns trimmed HTTP-header
 * credentials when app credentials are configured — against a mocked runtime.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { FeishuWorkflowCredentialProvider } from "./workflow-credential-provider";

function createRuntime(settings: Record<string, unknown>) {
	return Object.assign(Object.create(null) as IAgentRuntime, {
		getSetting: vi.fn((key: string) => settings[key]),
	});
}

describe("FeishuWorkflowCredentialProvider", () => {
	it("returns trimmed HTTP header credentials when app credentials are configured", async () => {
		const provider = new FeishuWorkflowCredentialProvider(
			createRuntime({
				FEISHU_APP_ID: " cli_test ",
				FEISHU_APP_SECRET: " secret ",
			}),
		);

		await expect(provider.resolve("user", "httpHeaderAuth")).resolves.toEqual({
			status: "credential_data",
			data: {
				name: "X-Feishu-App-Id",
				value: "cli_test",
				appSecret: "secret",
			},
		});
	});

	it("fails closed when runtime settings lookup throws", async () => {
		const runtime = Object.assign(Object.create(null) as IAgentRuntime, {
			getSetting: vi.fn(() => {
				throw new Error("settings unavailable");
			}),
		});
		const provider = new FeishuWorkflowCredentialProvider(runtime);

		await expect(
			provider.resolve("user", "httpHeaderAuth"),
		).resolves.toBeNull();
	});

	it("reports unsupported credential types without returning auth material", async () => {
		const provider = new FeishuWorkflowCredentialProvider(createRuntime({}));

		expect(provider.checkCredentialTypes(["httpHeaderAuth", "oauth2"])).toEqual(
			{
				supported: ["httpHeaderAuth"],
				unsupported: ["oauth2"],
			},
		);
		await expect(provider.resolve("user", "oauth2")).resolves.toBeNull();
	});
});
