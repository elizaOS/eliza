import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BlueSkyService } from "../services/bluesky";
import {
	listBlueSkyAccountIds,
	resolveDefaultBlueSkyAccountId,
	validateBlueSkyConfig,
} from "../utils/config";

function runtime(settings: Record<string, string>): IAgentRuntime {
	return {
		character: { settings: {} },
		getSetting: vi.fn((key: string) => settings[key] ?? null),
	} as unknown as IAgentRuntime;
}

describe("BlueSky account config", () => {
	it("preserves legacy env settings as the default account", () => {
		const rt = runtime({
			BLUESKY_HANDLE: "agent.example.com",
			BLUESKY_PASSWORD: "app-password",
		});

		expect(resolveDefaultBlueSkyAccountId(rt)).toBe("default");
		expect(listBlueSkyAccountIds(rt)).toContain("default");
		expect(validateBlueSkyConfig(rt).accountId).toBe("default");
	});

	it("resolves a named account from BLUESKY_ACCOUNTS", () => {
		const rt = runtime({
			BLUESKY_DEFAULT_ACCOUNT_ID: "support",
			BLUESKY_ACCOUNTS: JSON.stringify({
				support: {
					handle: "support.example.com",
					password: "support-password",
				},
			}),
		});

		const config = validateBlueSkyConfig(rt);
		expect(config.accountId).toBe("support");
		expect(config.handle).toBe("support.example.com");
	});

	it("registers message and post connectors for each initialized account", () => {
		const rt = {
			agentId: "agent-1",
			logger: {
				info: vi.fn(),
				warn: vi.fn(),
			},
			registerMessageConnector: vi.fn(),
			registerPostConnector: vi.fn(),
		} as unknown as IAgentRuntime & {
			registerPostConnector: ReturnType<typeof vi.fn>;
		};
		const service = new BlueSkyService() as unknown as {
			agents: Map<string, unknown>;
		};
		const messageService = (accountId: string) => ({
			getAccountId: () => accountId,
			handleSendMessage: vi.fn(),
			resolveConnectorTargets: vi.fn(),
			listRecentConnectorTargets: vi.fn(),
			listConnectorRooms: vi.fn(),
			getConnectorChatContext: vi.fn(),
			getConnectorUserContext: vi.fn(),
			fetchConnectorMessages: vi.fn(),
		});
		const postService = (accountId: string) => ({
			getAccountId: () => accountId,
			handleSendPost: vi.fn(),
			fetchFeed: vi.fn(),
			searchPosts: vi.fn(),
		});

		service.agents.set("agent-1", {
			defaultAccountId: "default",
			managers: new Map([
				["default", {}],
				["support", {}],
			]),
			messageServices: new Map([
				["default", messageService("default")],
				["support", messageService("support")],
			]),
			postServices: new Map([
				["default", postService("default")],
				["support", postService("support")],
			]),
		});

		BlueSkyService.registerSendHandlers(
			rt,
			service as unknown as BlueSkyService,
		);

		expect(rt.registerMessageConnector).toHaveBeenCalledTimes(2);
		expect(rt.registerPostConnector).toHaveBeenCalledTimes(2);
		expect(
			(rt.registerMessageConnector as ReturnType<typeof vi.fn>).mock.calls.map(
				([registration]) => registration.accountId,
			),
		).toEqual(["default", "support"]);
		expect(
			rt.registerPostConnector.mock.calls.map(
				([registration]) => registration.accountId,
			),
		).toEqual(["default", "support"]);
	});
});
