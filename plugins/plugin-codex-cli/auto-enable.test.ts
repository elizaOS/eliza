import { describe, expect, it } from "vitest";
import { shouldEnable, shouldForce } from "./codex-cli-auto-enable";

function ctx(config: Record<string, unknown>): {
	env: Record<string, string | undefined>;
	config: Record<string, unknown>;
	isNativePlatform: boolean;
} {
	return { env: {}, config, isNativePlatform: false };
}

describe("plugin-codex-cli auto-enable", () => {
	it("enables when an auth profile selects the codex-cli provider", () => {
		expect(
			shouldEnable(ctx({ auth: { profiles: { dev: { provider: "codex-cli" } } } })),
		).toBe(true);
	});

	it("does NOT enable when no auth profiles are configured", () => {
		expect(shouldEnable(ctx({}))).toBe(false);
		expect(shouldEnable(ctx({ auth: {} }))).toBe(false);
		expect(shouldEnable(ctx({ auth: { profiles: {} } }))).toBe(false);
	});

	it("does NOT enable when profiles select a different provider", () => {
		expect(
			shouldEnable(ctx({ auth: { profiles: { dev: { provider: "anthropic" } } } })),
		).toBe(false);
	});

	it("skips non-object profile entries", () => {
		expect(shouldEnable(ctx({ auth: { profiles: { dev: "codex-cli" } } }))).toBe(false);
	});

	it("force-enables when the openai-codex subscription is selected", () => {
		expect(
			shouldForce(ctx({ agents: { defaults: { subscriptionProvider: "openai-codex" } } })),
		).toBe(true);
	});

	it("does NOT force-enable for other subscription providers", () => {
		expect(
			shouldForce(ctx({ agents: { defaults: { subscriptionProvider: "pro" } } })),
		).toBe(false);
		expect(shouldForce(ctx({}))).toBe(false);
	});
});
