import { describe, expect, it, vi } from "vitest";

vi.mock("./build-variant.js", () => ({
	getBuildVariant: vi.fn(() => "direct"),
	getDirectDownloadUrl: vi.fn(() => "https://example.com/download"),
}));

import { getBuildVariant } from "./build-variant.js";
import {
	buildStoreVariantBlockedMessage,
	isLocalCodeExecutionAllowed,
} from "./sandbox-policy.js";

describe("sandbox-policy", () => {
	it("allows when direct", () => {
		vi.mocked(getBuildVariant).mockReturnValue("direct");
		expect(isLocalCodeExecutionAllowed()).toBe(true);
	});

	it("blocks when not direct", () => {
		vi.mocked(getBuildVariant).mockReturnValue("store" as never);
		expect(isLocalCodeExecutionAllowed()).toBe(false);
	});

	it("builds blocked message", () => {
		const msg = buildStoreVariantBlockedMessage("Tool");
		expect(msg).toContain("Tool requires");
		expect(msg).toContain("https://example.com/download");
	});
});
