import { describe, expect, it } from "vitest";
import { resolveElectrobunCopyMap } from "../electrobun.config";

describe("Electrobun Store packaging", () => {
	it("omits the embedded local agent runtime tree for Mac App Store builds", () => {
		const copy = resolveElectrobunCopyMap({
			buildVariant: "store",
			runtimeDistDir: "eliza-dist",
		});

		expect(Object.values(copy)).not.toContain("eliza-dist");
		expect(
			Object.values(copy).some((target) => target.startsWith("eliza-dist/")),
		).toBe(false);
	});

	it("keeps the embedded runtime tree for direct desktop builds", () => {
		const copy = resolveElectrobunCopyMap({
			buildVariant: "direct",
			runtimeDistDir: "eliza-dist",
		});

		expect(Object.values(copy)).toContain("eliza-dist");
		expect(Object.values(copy)).toContain("eliza-dist/package.json");
	});
});
