/**
 * Coverage for build-variant.
 */
import { describe, expect, it } from "vitest";
import {
	_resetBuildVariantForTests,
	BUILD_VARIANTS,
	DEFAULT_BUILD_VARIANT,
	getBuildVariant,
	isDirectBuild,
	isStoreBuild,
} from "./build-variant.js";

describe("build-variant", () => {
	it("exposes the canonical variant list and default", () => {
		expect(BUILD_VARIANTS).toEqual(["store", "direct"]);
		expect(DEFAULT_BUILD_VARIANT).toBe("direct");
	});

	it("defaults to direct when unset", () => {
		_resetBuildVariantForTests();
		expect(getBuildVariant()).toBe("direct");
		expect(isDirectBuild()).toBe(true);
		expect(isStoreBuild()).toBe(false);
	});

	it("honors an explicit store variant via env", () => {
		_resetBuildVariantForTests();
		process.env.ELIZA_BUILD_VARIANT = "store";
		try {
			expect(getBuildVariant()).toBe("store");
			expect(isStoreBuild()).toBe(true);
			expect(isDirectBuild()).toBe(false);
		} finally {
			delete process.env.ELIZA_BUILD_VARIANT;
		}
	});

	it("falls back to direct for unknown variants", () => {
		_resetBuildVariantForTests();
		process.env.ELIZA_BUILD_VARIANT = "bogus";
		try {
			expect(getBuildVariant()).toBe("direct");
			expect(isDirectBuild()).toBe(true);
		} finally {
			delete process.env.ELIZA_BUILD_VARIANT;
		}
	});

	it("can be reset for tests", () => {
		_resetBuildVariantForTests();
		process.env.ELIZA_BUILD_VARIANT = "store";
		try {
			expect(getBuildVariant()).toBe("store");
		} finally {
			delete process.env.ELIZA_BUILD_VARIANT;
		}
		_resetBuildVariantForTests();
		expect(getBuildVariant()).toBe("direct");
	});
});
