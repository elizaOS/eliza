import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
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
});
