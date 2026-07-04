/**
 * Covers config parsing (`getConfigFromRuntime`), multi-account resolution, and
 * handle allowlist policy (`isHandleAllowed`) against hand-built runtime
 * settings — deterministic, no live server.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	listBlueBubblesAccountIds,
	listEnabledBlueBubblesAccounts,
	resolveBlueBubblesAccount,
	resolveDefaultBlueBubblesAccountId,
} from "../src/accounts";
import { createBlueBubblesConnectorAccountProvider } from "../src/connector-account-provider";
import { getConfigFromRuntime, isHandleAllowed } from "../src/environment";
import { BlueBubblesService } from "../src/service";

function makeRuntime(
	settings: Record<string, unknown>,
	characterSettings: Record<string, unknown> = {},
): IAgentRuntime {
	return {
		getSetting: (key: string) => settings[key],
		character: {
			name: "Test Agent",
			settings: characterSettings,
		},
	} as unknown as IAgentRuntime;
}

describe("getConfigFromRuntime", () => {
	it("returns null instead of a partial config when server URL or password is missing", () => {
		expect(
			getConfigFromRuntime(
				makeRuntime({
					BLUEBUBBLES_SERVER_URL: "http://localhost:1234",
				}),
			),
		).toBeNull();
		expect(
			getConfigFromRuntime(
				makeRuntime({
					BLUEBUBBLES_PASSWORD: "secret",
				}),
			),
		).toBeNull();
	});

	it("parses JSON auto-start args, trims allow lists, and falls back on invalid waits", () => {
		const config = getConfigFromRuntime(
			makeRuntime({
				BLUEBUBBLES_SERVER_URL: "http://localhost:1234",
				BLUEBUBBLES_PASSWORD: "secret",
				BLUEBUBBLES_ALLOW_FROM: " +1 (415) 555-2671, alice@example.com, ",
				BLUEBUBBLES_GROUP_ALLOW_FROM: " group@example.com ,, +14155559999 ",
				BLUEBUBBLES_AUTOSTART_ARGS: '[" --flag ", 42, "value"]',
				BLUEBUBBLES_AUTOSTART_WAIT_MS: "-1",
				BLUEBUBBLES_SEND_READ_RECEIPTS: "false",
				BLUEBUBBLES_ENABLED: "false",
			}),
		);

		expect(config).toEqual(
			expect.objectContaining({
				allowFrom: ["+1 (415) 555-2671", "alice@example.com"],
				groupAllowFrom: ["group@example.com", "+14155559999"],
				autoStartArgs: ["--flag", "value"],
				autoStartWaitMs: 15000,
				sendReadReceipts: false,
				enabled: false,
			}),
		);
	});

	it("falls back to comma-separated auto-start args when JSON is malformed", () => {
		const config = getConfigFromRuntime(
			makeRuntime({
				BLUEBUBBLES_SERVER_URL: "http://localhost:1234",
				BLUEBUBBLES_PASSWORD: "secret",
				BLUEBUBBLES_AUTOSTART_ARGS: "[--flag, value",
			}),
		);

		expect(config?.autoStartArgs).toEqual(["[--flag", "value"]);
	});
});

describe("BlueBubbles account resolution", () => {
	it("resolves configured character accounts and preserves account-level overrides", () => {
		const runtime = makeRuntime(
			{
				BLUEBUBBLES_SERVER_URL: "http://env.example:1234",
				BLUEBUBBLES_PASSWORD: "env-secret",
				BLUEBUBBLES_ALLOW_FROM: "+14155552671, alice@example.com",
			},
			{
				bluebubbles: {
					serverUrl: "http://base.example:1234",
					password: "base-secret",
					allowFrom: ["base@example.com"],
					accounts: {
						work: {
							name: "Work Mac",
							serverUrl: "http://work.example:1234",
							password: "work-secret",
							dmPolicy: "allowlist",
							allowFrom: ["work@example.com"],
							sendReadReceipts: false,
						},
					},
				},
			},
		);

		expect(listBlueBubblesAccountIds(runtime)).toEqual(["default", "work"]);
		expect(resolveDefaultBlueBubblesAccountId(runtime)).toBe("default");
		expect(resolveBlueBubblesAccount(runtime, "work")).toEqual(
			expect.objectContaining({
				accountId: "work",
				enabled: true,
				name: "Work Mac",
				serverUrl: "http://work.example:1234",
				configured: true,
				config: expect.objectContaining({
					serverUrl: "http://work.example:1234",
					password: "work-secret",
					dmPolicy: "allowlist",
					allowFrom: ["work@example.com"],
					sendReadReceipts: false,
				}),
			}),
		);
	});

	it("selects the first configured character account when no default account exists", () => {
		const runtime = makeRuntime(
			{},
			{
				bluebubbles: {
					accounts: {
						work: {
							serverUrl: "http://work.example:1234",
							password: "work-secret",
						},
					},
				},
			},
		);

		expect(
			listEnabledBlueBubblesAccounts(runtime).map((item) => item.accountId),
		).toEqual(["work"]);
		expect(resolveDefaultBlueBubblesAccountId(runtime)).toBe("work");

		const service = new BlueBubblesService(runtime);
		expect(service.getAccountId()).toBe("work");
		expect(service.getConfig()).toEqual(
			expect.objectContaining({
				serverUrl: "http://work.example:1234",
				password: "work-secret",
			}),
		);
	});

	it("lists enabled character accounts through the connector account provider", async () => {
		const runtime = makeRuntime(
			{},
			{
				bluebubbles: {
					accounts: {
						personal: {
							serverUrl: "http://personal.example:1234",
							password: "personal-secret",
						},
						disabled: {
							enabled: false,
							serverUrl: "http://disabled.example:1234",
							password: "disabled-secret",
						},
					},
				},
			},
		);
		const provider = createBlueBubblesConnectorAccountProvider(runtime);

		await expect(provider.listAccounts({} as never)).resolves.toEqual([
			expect.objectContaining({
				id: "personal",
				provider: "bluebubbles",
				status: "connected",
				externalId: "http://personal.example:1234",
			}),
		]);
	});
});

describe("isHandleAllowed", () => {
	it("normalizes phone and email handles before allowlist comparison", () => {
		expect(
			isHandleAllowed("+1 (415) 555-2671", ["14155552671"], "allowlist"),
		).toBe(true);
		expect(
			isHandleAllowed("ALICE@EXAMPLE.COM", ["alice@example.com"], "allowlist"),
		).toBe(true);
	});

	it("keeps disabled and empty allowlist policies restrictive except pairing", () => {
		expect(isHandleAllowed("+14155552671", [], "disabled")).toBe(false);
		expect(isHandleAllowed("+14155552671", [], "allowlist")).toBe(false);
		expect(isHandleAllowed("+14155552671", [], "pairing")).toBe(true);
	});
});
