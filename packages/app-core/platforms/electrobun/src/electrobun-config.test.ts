import { describe, expect, it } from "vitest";
import {
	resolveElectrobunCopyMap,
	shouldEmbedRuntimeBundle,
} from "../electrobun.config";

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

	it("omits the embedded runtime tree for external API desktop builds", () => {
		const copy = resolveElectrobunCopyMap({
			buildVariant: "direct",
			runtimeDistDir: "eliza-dist",
			embedRuntime: shouldEmbedRuntimeBundle({
				ELIZA_DESKTOP_API_BASE: "http://127.0.0.1:31337",
			}),
		});

		expect(Object.values(copy)).not.toContain("eliza-dist");
		expect(Object.values(copy)).not.toContain("eliza-dist/package.json");
	});

	it("keeps the embedded runtime tree when external API env is invalid", () => {
		const copy = resolveElectrobunCopyMap({
			buildVariant: "direct",
			runtimeDistDir: "eliza-dist",
			embedRuntime: shouldEmbedRuntimeBundle({
				ELIZA_DESKTOP_API_BASE: "not-a-url",
			}),
		});

		expect(Object.values(copy)).toContain("eliza-dist");
		expect(Object.values(copy)).toContain("eliza-dist/package.json");
	});
});
