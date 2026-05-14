import { describe, expect, it } from "vitest";
import { BUILT_IN_PROVIDERS } from "./providers";

describe("local inference provider catalog", () => {
	it("advertises Eliza-1 as the local provider for every default local modality", () => {
		const local = BUILT_IN_PROVIDERS.find(
			(provider) => provider.id === "eliza-local-inference",
		);

		expect(local?.supportedSlots).toEqual(
			expect.arrayContaining([
				"TEXT_SMALL",
				"TEXT_LARGE",
				"TEXT_EMBEDDING",
				"TEXT_TO_SPEECH",
				"TRANSCRIPTION",
				"IMAGE_DESCRIPTION",
			]),
		);
	});

	it("has no other local provider claiming the complete Eliza-1 default surface", () => {
		const completeLocalProviders = BUILT_IN_PROVIDERS.filter(
			(provider) =>
				(provider.kind === "local" || provider.kind === "device-bridge") &&
				[
					"TEXT_SMALL",
					"TEXT_LARGE",
					"TEXT_EMBEDDING",
					"TEXT_TO_SPEECH",
					"TRANSCRIPTION",
					"IMAGE_DESCRIPTION",
				].every((slot) => provider.supportedSlots.includes(slot as never)),
		).map((provider) => provider.id);

		expect(completeLocalProviders).toEqual(["eliza-local-inference"]);
	});
});
