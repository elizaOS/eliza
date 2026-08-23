/**
 * Unit tests for application build variant resolution (store vs direct).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetBuildVariantForTests,
	BUILD_VARIANTS,
	DEFAULT_BUILD_VARIANT,
	getBuildVariant,
	getDirectDownloadUrl,
	isDirectBuild,
	isStoreBuild,
} from "./build-variant.js";

describe("build-variant", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		_resetBuildVariantForTests();
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		_resetBuildVariantForTests();
	});

	it("defaults to direct build when ELIZA_BUILD_VARIANT is unset", () => {
		delete process.env.ELIZA_BUILD_VARIANT;
		_resetBuildVariantForTests();

		expect(getBuildVariant()).toBe("direct");
		expect(isDirectBuild()).toBe(true);
		expect(isStoreBuild()).toBe(false);
	});

	it("resolves store build when ELIZA_BUILD_VARIANT is set to store", () => {
		process.env.ELIZA_BUILD_VARIANT = "store";
		_resetBuildVariantForTests();

		expect(getBuildVariant()).toBe("store");
		expect(isStoreBuild()).toBe(true);
		expect(isDirectBuild()).toBe(false);
	});

	it("handles whitespace and case-insensitive variant values", () => {
		process.env.ELIZA_BUILD_VARIANT = " STORE ";
		_resetBuildVariantForTests();

		expect(getBuildVariant()).toBe("store");
	});

	it("falls back to default direct build when variant value is unknown", () => {
		process.env.ELIZA_BUILD_VARIANT = "invalid-variant-name";
		_resetBuildVariantForTests();

		expect(getBuildVariant()).toBe("direct");
	});

	it("returns canonical download URL and constants", () => {
		expect(getDirectDownloadUrl()).toBe("https://eliza.so/download");
		expect(DEFAULT_BUILD_VARIANT).toBe("direct");
		expect(BUILD_VARIANTS).toEqual(["store", "direct"]);
	});
});
