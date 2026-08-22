import { describe, expect, it, vi } from "vitest";

const variant = vi.hoisted(() => ({
	value: "direct" as "direct" | "store",
}));

vi.mock("../build-variant.js", () => ({
	getBuildVariant: () => variant.value,
	getDirectDownloadUrl: () => "https://eliza.so/download",
}));

import {
	buildStoreVariantBlockedMessage,
	isLocalCodeExecutionAllowed,
} from "../sandbox-policy.ts";

describe("isLocalCodeExecutionAllowed", () => {
	it("allows on direct builds", () => {
		variant.value = "direct";
		expect(isLocalCodeExecutionAllowed()).toBe(true);
	});

	it("blocks on store builds", () => {
		variant.value = "store";
		expect(isLocalCodeExecutionAllowed()).toBe(false);
	});
});

describe("buildStoreVariantBlockedMessage", () => {
	it("mentions the feature, the sandbox, and the download URL", () => {
		const message = buildStoreVariantBlockedMessage("Code execution");
		expect(message).toContain("Code execution");
		expect(message).toContain("direct download");
		expect(message).toContain("https://eliza.so/download");
	});
});
