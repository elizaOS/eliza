import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { getConfigFromRuntime, isHandleAllowed } from "../src/environment";

function makeRuntime(settings: Record<string, unknown>): IAgentRuntime {
	return {
		getSetting: (key: string) => settings[key],
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
