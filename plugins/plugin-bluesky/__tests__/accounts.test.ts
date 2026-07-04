/**
 * Unit tests for multi-account config resolution and the connector-account
 * provider, driven by an in-memory fake runtime (no network, no real SDK).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createBlueSkyConnectorAccountProvider } from "../connector-account-provider";
import { BlueSkyService } from "../services/bluesky";
import {
	hasBlueSkyEnabled,
	listBlueSkyAccountIds,
	readBlueSkyAccountId,
	resolveDefaultBlueSkyAccountId,
	validateBlueSkyConfig,
} from "../utils/config";

function runtime(
	settings: Record<string, string | null>,
	characterSettings: Record<string, unknown> = {},
): IAgentRuntime {
	return {
		character: { settings: characterSettings },
		getSetting: vi.fn((key: string) => settings[key] ?? null),
	} as IAgentRuntime;
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

	it("ignores malformed BLUESKY_ACCOUNTS and falls back to legacy default", () => {
		const rt = runtime({
			BLUESKY_ACCOUNTS: "{not json",
			BLUESKY_HANDLE: "agent.example.com",
			BLUESKY_PASSWORD: "app-password",
		});

		expect(listBlueSkyAccountIds(rt)).toEqual(["default"]);
		expect(resolveDefaultBlueSkyAccountId(rt)).toBe("default");
	});

	it("does not leak default env credentials into explicitly requested named accounts", () => {
		const rt = runtime({
			BLUESKY_HANDLE: "agent.example.com",
			BLUESKY_PASSWORD: "app-password",
		});

		expect(() => validateBlueSkyConfig(rt, "support")).toThrow(
			/Invalid BlueSky configuration/,
		);
	});

	it("treats explicit false enabled settings as disabled even with credentials", () => {
		const rt = runtime({
			BLUESKY_ENABLED: "false",
			BLUESKY_HANDLE: "agent.example.com",
			BLUESKY_PASSWORD: "app-password",
		});

		expect(hasBlueSkyEnabled(rt)).toBe(false);
	});

	it("reads account ids from nested connector payloads in priority order", () => {
		expect(
			readBlueSkyAccountId(
				{ metadata: { accountId: "ignored" } },
				{
					parameters: { accountId: " support " },
					data: { bluesky: { accountId: "nested" } },
				},
			),
		).toBe("ignored");
		expect(
			readBlueSkyAccountId({ data: { bluesky: { accountId: "ops" } } }),
		).toBe("ops");
		expect(readBlueSkyAccountId({ accountId: " " })).toBeUndefined();
	});

	it("lists connector accounts as disabled instead of throwing on invalid account config", async () => {
		const rt = runtime(
			{},
			{
				bluesky: {
					accounts: {
						broken: {
							handle: "not a valid handle",
							password: "app-password",
						},
					},
				},
			},
		);
		const provider = createBlueSkyConnectorAccountProvider(rt);

		await expect(provider.listAccounts({} as never)).resolves.toMatchObject([
			{
				id: "broken",
				provider: "bluesky",
				status: "disabled",
				label: "broken",
			},
		]);
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
		} as IAgentRuntime & {
			registerPostConnector: ReturnType<typeof vi.fn>;
		};
		const service = new BlueSkyService() as BlueSkyService & {
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

		BlueSkyService.registerSendHandlers(rt, service);

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

	it("falls back to the legacy send handler when connector registration is unavailable", () => {
		const rt = {
			agentId: "agent-1",
			logger: {
				info: vi.fn(),
				warn: vi.fn(),
			},
			registerSendHandler: vi.fn(),
		} as unknown as IAgentRuntime & {
			registerSendHandler: ReturnType<typeof vi.fn>;
		};
		const service = new BlueSkyService() as BlueSkyService & {
			agents: Map<string, unknown>;
		};
		const handleSendMessage = vi.fn();
		service.agents.set("agent-1", {
			defaultAccountId: "default",
			managers: new Map([["default", {}]]),
			messageServices: new Map([
				[
					"default",
					{
						getAccountId: () => "default",
						handleSendMessage,
					},
				],
			]),
			postServices: new Map(),
		});

		BlueSkyService.registerSendHandlers(rt, service);

		expect(rt.registerSendHandler).toHaveBeenCalledOnce();
		expect(rt.registerSendHandler.mock.calls[0]?.[0]).toBe("bluesky");
	});

	it("warns instead of registering handlers when service has no agent state", () => {
		const rt = {
			agentId: "agent-1",
			logger: {
				warn: vi.fn(),
			},
			registerMessageConnector: vi.fn(),
			registerSendHandler: vi.fn(),
		} as unknown as IAgentRuntime & {
			registerMessageConnector: ReturnType<typeof vi.fn>;
			registerSendHandler: ReturnType<typeof vi.fn>;
		};
		const service = new BlueSkyService() as BlueSkyService & {
			agents: Map<string, unknown>;
		};

		BlueSkyService.registerSendHandlers(rt, service);

		expect(rt.logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "agent-1", src: "plugin:bluesky" }),
			expect.stringContaining("service is not initialized"),
		);
		expect(rt.registerMessageConnector).not.toHaveBeenCalled();
		expect(rt.registerSendHandler).not.toHaveBeenCalled();
	});
});
