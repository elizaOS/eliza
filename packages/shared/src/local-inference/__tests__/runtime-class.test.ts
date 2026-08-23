import { describe, expect, it } from "vitest";
import {
	classifyCatalogModelRuntimeClass,
	classifyInstalledModelRuntimeClass,
	withRuntimeClass,
} from "./runtime-class.ts";

describe("classify* runtime class", () => {
	it("classifies catalog models as fused-eliza1", () => {
		expect(
			classifyCatalogModelRuntimeClass({
				id: "m",
				bundleManifestFile: "x",
			} as never),
		).toBe("fused-eliza1");
	});

	it("classifies installed models as fused-eliza1", () => {
		expect(
			classifyInstalledModelRuntimeClass({ id: "m", bundleRoot: "r" } as never),
		).toBe("fused-eliza1");
	});
});

describe("withRuntimeClass", () => {
	it("backfills the runtimeClass for entries missing it", () => {
		const model = { id: "m", bundleRoot: "r" } as never;
		const out = withRuntimeClass(model);
		expect(out.runtimeClass).toBe("fused-eliza1");
		expect(out).toMatchObject({ id: "m", bundleRoot: "r" });
	});

	it("preserves an existing runtimeClass", () => {
		const model = {
			id: "m",
			bundleRoot: "r",
			runtimeClass: "fused-eliza1",
		} as never;
		expect(withRuntimeClass(model)).toBe(model);
	});
});
