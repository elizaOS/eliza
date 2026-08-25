/**
 * Unit tests for sandbox-policy singleton.
 * Consolidated from colocated and __tests__/sandbox-policy suites.
 * Preserves all unique assertions: direct/store gating, Tool-requires
 * message with download URL, and Code execution + direct download + URL checks.
 */
import { describe, expect, it, vi } from "vitest";

const variant = vi.hoisted(() => ({
	value: "direct" as "direct" | "store",
}));

vi.mock("./build-variant.js", () => ({
	getBuildVariant: () => variant.value,
	getDirectDownloadUrl: () => "https://eliza.so/download",
}));

import {
	buildStoreVariantBlockedMessage,
	isLocalCodeExecutionAllowed,
} from "./sandbox-policy.js";

describe("sandbox-policy", () => {
	it("allows when direct", () => {
		variant.value = "direct";
		expect(isLocalCodeExecutionAllowed()).toBe(true);
	});

	it("blocks when not direct", () => {
		variant.value = "store";
		expect(isLocalCodeExecutionAllowed()).toBe(false);
	});

	it("builds blocked message with feature label and download URL (colocated)", () => {
		const msg = buildStoreVariantBlockedMessage("Tool");
		expect(msg).toContain("Tool requires");
		expect(msg).toContain("https://eliza.so/download");
	});

	it("mentions the feature, the sandbox, and the download URL (from __tests__)", () => {
		const message = buildStoreVariantBlockedMessage("Code execution");
		expect(message).toContain("Code execution");
		expect(message).toContain("direct download");
		expect(message).toContain("https://eliza.so/download");
	});
});
