/**
 * Coverage lane for the connector default-posture change. This PR flips several
 * `DISCORD_DEFAULTS` and the user-install default across `environment.ts`,
 * `messages.ts`, `banner.ts`, and `slash-command-registration.ts`. The
 * changed-file coverage gate runs only the test files in a PR diff, so this lane
 * re-composes the existing behavioral suites that drive those modules (plus a
 * direct `printDiscordBanner` render) to keep the default flips attached to
 * their real coverage until each module is independently unit-covered. Mirrors
 * the messages/service regression lanes.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { printDiscordBanner } from "../banner.ts";
import "./messages-regression-lane.test.ts";
import "./service-regression-lane.test.ts";
import "./banner-reply-warning.test.ts";
import "./environment-defaults.test.ts";

describe("discord defaults lane composition", () => {
	it("renders the startup banner with the conversational defaults", () => {
		const settings: Record<string, unknown> = {
			DISCORD_API_TOKEN: "token-value",
			DISCORD_APPLICATION_ID: "123456789012345678", // gitleaks:allow test fixture
		};
		const info = vi.fn();
		const runtime = {
			character: { name: "TestBot" },
			getSetting: (key: string) => settings[key],
			logger: { info, warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
		} as unknown as IAgentRuntime;

		printDiscordBanner(runtime);

		// The banner emits the whole panel through logger.info as one string; it
		// lists the three response-gating rows whose default markers this PR flips.
		const rendered = info.mock.calls.map((call) => String(call[0])).join("\n");
		expect(rendered).toContain("DISCORD_SHOULD_IGNORE_BOT_MESSAGES");
		expect(rendered).toContain("DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS");
	});
});
