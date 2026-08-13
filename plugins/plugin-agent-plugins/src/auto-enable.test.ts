import type { PluginAutoEnableContext } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { shouldEnable } from "../auto-enable";

describe("shouldEnable", () => {
	it("enables when features.agentPlugins is true", () => {
		expect(
			shouldEnable({
				config: { features: { agentPlugins: true } },
			} as PluginAutoEnableContext),
		).toBe(true);
	});

	it("enables when the feature object is not explicitly disabled", () => {
		expect(
			shouldEnable({
				config: { features: { agentPlugins: {} } },
			} as PluginAutoEnableContext),
		).toBe(true);
	});

	it("does not enable when the feature is absent", () => {
		expect(
			shouldEnable({
				config: { features: {} },
			} as PluginAutoEnableContext),
		).toBe(false);
	});
});
