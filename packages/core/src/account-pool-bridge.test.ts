/**
 * Verifies both global account-pool bridges install, replace, and clear through
 * the shared symbols consumed across package boundaries.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	type AnthropicAccountPoolBridge,
	type CodingAgentSelectorBridge,
	getAnthropicAccountPoolBridge,
	getCodingAgentSelectorBridge,
	setAnthropicAccountPoolBridge,
	setCodingAgentSelectorBridge,
} from "./account-pool-bridge.ts";

afterEach(() => {
	setAnthropicAccountPoolBridge(null);
	setCodingAgentSelectorBridge(null);
});

describe("account-pool global bridges", () => {
	it("round-trips and clears the Anthropic bridge", () => {
		const bridge = {
			selectAnthropicSubscription: async () => null,
			getAccessToken: async () => null,
			markInvalid: async () => undefined,
			markRateLimited: async () => undefined,
		} satisfies AnthropicAccountPoolBridge;

		setAnthropicAccountPoolBridge(bridge);
		expect(getAnthropicAccountPoolBridge()).toBe(bridge);
		setAnthropicAccountPoolBridge(null);
		expect(getAnthropicAccountPoolBridge()).toBeNull();
	});

	it("round-trips and replaces the coding-agent bridge", () => {
		const makeBridge = (): CodingAgentSelectorBridge => ({
			describe: () => ({}),
			select: async () => null,
			markRateLimited: async () => undefined,
			markNeedsReauth: async () => undefined,
			recordUsage: async () => undefined,
		});
		const first = makeBridge();
		const second = makeBridge();

		setCodingAgentSelectorBridge(first);
		expect(getCodingAgentSelectorBridge()).toBe(first);
		setCodingAgentSelectorBridge(second);
		expect(getCodingAgentSelectorBridge()).toBe(second);
	});
});
