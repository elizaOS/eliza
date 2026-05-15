import type { ImageDescriptionResult } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { LocalImageDescriptionHandler } from "./cloud-fallback";
import { withVisionFallbackChain } from "./index";

const localResult: ImageDescriptionResult = {
	title: "Local",
	description: "local description",
};

const cloudResult: ImageDescriptionResult = {
	title: "Cloud",
	description: "cloud description",
};

const vastResult: ImageDescriptionResult = {
	title: "Vast",
	description: "vast description",
};

describe("vision fallback chain", () => {
	it("returns local IMAGE_DESCRIPTION results without calling fallbacks", async () => {
		let cloudCalls = 0;
		const handler = withVisionFallbackChain(async () => localResult, {
			cloud: {
				handler: async () => {
					cloudCalls += 1;
					return cloudResult;
				},
			},
		});

		await expect(handler({} as never, "data:image/png;base64,a")).resolves.toBe(
			localResult,
		);
		expect(cloudCalls).toBe(0);
	});

	it("falls through local to cloud", async () => {
		const local: LocalImageDescriptionHandler = async () => ({
			kind: "fallback",
			reason: "local-unavailable",
		});
		const handler = withVisionFallbackChain(local, {
			cloud: { handler: async () => cloudResult },
		});

		await expect(handler({} as never, "data:image/png;base64,a")).resolves.toBe(
			cloudResult,
		);
	});

	it("falls through cloud to vast", async () => {
		const handler = withVisionFallbackChain(
			async () => ({ kind: "fallback", reason: "local-error" }),
			{
				cloud: {
					handler: async () => ({ kind: "fallback", reason: "cloud-error" }),
				},
				vast: { handler: async () => vastResult },
			},
		);

		await expect(handler({} as never, "data:image/png;base64,a")).resolves.toBe(
			vastResult,
		);
	});

	it("throws a structured error when every provider falls back", async () => {
		const handler = withVisionFallbackChain(
			async () => ({ kind: "fallback", reason: "local-error" }),
			{
				cloud: {
					handler: async () => ({ kind: "fallback", reason: "cloud-error" }),
				},
				vast: {
					handler: async () => ({ kind: "fallback", reason: "vast-error" }),
				},
			},
		);

		await expect(
			handler({} as never, "data:image/png;base64,a"),
		).rejects.toThrow("all IMAGE_DESCRIPTION providers exhausted");
	});
});
