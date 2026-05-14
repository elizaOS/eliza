import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { modelTypeToSlot } from "./router-handler";

describe("local inference router slots", () => {
	it("routes IMAGE_DESCRIPTION through the local-first provider policy", () => {
		expect(modelTypeToSlot(ModelType.IMAGE_DESCRIPTION)).toBe(
			"IMAGE_DESCRIPTION",
		);
	});
});
