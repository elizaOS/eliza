import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetBuildVariantForTests } from "../build-variant.ts";
import {
	_setAppBundleRootForTests,
	assertDlopenPathAllowed,
	isPathInsideAppBundle,
} from "./dlopen-gate.ts";

const ORIGINAL_VARIANT = process.env.ELIZA_BUILD_VARIANT;

function setBuildVariant(variant: "store" | "direct" | undefined): void {
	if (variant === undefined) {
		delete process.env.ELIZA_BUILD_VARIANT;
	} else {
		process.env.ELIZA_BUILD_VARIANT = variant;
	}
	_resetBuildVariantForTests();
}

/**
 * Build a fake `.app/Contents/MacOS` directory under a per-test tempdir so
 * the gate's path normalization has real on-disk targets to anchor to. We
 * only need real directories so `resolve()`-based prefix checks behave
 * exactly as they would for a real bundle; the dylib files do not need to
 * exist.
 */
function makeFakeBundle(): { contents: string } {
	const root = mkdtempSync(join(tmpdir(), "dlopen-gate-test-"));
	const contents = join(root, "Eliza.app", "Contents");
	mkdirSync(join(contents, "MacOS"), { recursive: true });
	mkdirSync(join(contents, "Frameworks"), { recursive: true });
	return { contents };
}

describe("dlopen-gate", () => {
	beforeEach(() => {
		setBuildVariant("direct");
		_setAppBundleRootForTests(null);
	});

	afterEach(() => {
		_setAppBundleRootForTests(null);
		if (ORIGINAL_VARIANT === undefined) {
			delete process.env.ELIZA_BUILD_VARIANT;
		} else {
			process.env.ELIZA_BUILD_VARIANT = ORIGINAL_VARIANT;
		}
		_resetBuildVariantForTests();
	});

	describe("direct build", () => {
		it("allows any absolute path", () => {
			setBuildVariant("direct");
			expect(() =>
				assertDlopenPathAllowed("/tmp/anything.dylib"),
			).not.toThrow();
		});

		it("allows relative paths", () => {
			setBuildVariant("direct");
			expect(() => assertDlopenPathAllowed("./some/lib.dylib")).not.toThrow();
		});

		it("allows empty paths (Bun itself will reject, but the gate stays out of the way)", () => {
			setBuildVariant("direct");
			expect(() => assertDlopenPathAllowed("")).not.toThrow();
		});
	});

	describe("store build on darwin", () => {
		const isDarwin = process.platform === "darwin";

		(isDarwin ? it : it.skip)(
			"accepts a path inside the bundle Contents/MacOS",
			() => {
				const { contents } = makeFakeBundle();
				setBuildVariant("store");
				_setAppBundleRootForTests(contents);
				const bundleLib = join(contents, "MacOS", "libElizaShim.dylib");
				expect(() => assertDlopenPathAllowed(bundleLib)).not.toThrow();
			},
		);

		(isDarwin ? it : it.skip)(
			"accepts a path inside the bundle Contents/Frameworks",
			() => {
				const { contents } = makeFakeBundle();
				setBuildVariant("store");
				_setAppBundleRootForTests(contents);
				const bundleFrameworkLib = join(
					contents,
					"Frameworks",
					"libcore.dylib",
				);
				expect(() => assertDlopenPathAllowed(bundleFrameworkLib)).not.toThrow();
			},
		);

		(isDarwin ? it : it.skip)("rejects /tmp/evil.dylib outside the bundle", () => {
			const { contents } = makeFakeBundle();
			setBuildVariant("store");
			_setAppBundleRootForTests(contents);
			expect(() => assertDlopenPathAllowed("/tmp/evil.dylib")).toThrow(
				/Refusing to dlopen outside app bundle in store build/,
			);
		});

		(isDarwin ? it : it.skip)(
			"rejects bundle-relative path with .. traversal that escapes the bundle",
			() => {
				const { contents } = makeFakeBundle();
				setBuildVariant("store");
				_setAppBundleRootForTests(contents);
				const escaping = join(
					contents,
					"MacOS",
					"..",
					"..",
					"..",
					"evil.dylib",
				);
				expect(() => assertDlopenPathAllowed(escaping)).toThrow(
					/Refusing to dlopen outside app bundle in store build/,
				);
			},
		);

		(isDarwin ? it : it.skip)("rejects a relative path", () => {
			const { contents } = makeFakeBundle();
			setBuildVariant("store");
			_setAppBundleRootForTests(contents);
			expect(() => assertDlopenPathAllowed("./some/lib.dylib")).toThrow(
				/Refusing to dlopen relative path/,
			);
		});

		(isDarwin ? it : it.skip)("rejects an empty path", () => {
			const { contents } = makeFakeBundle();
			setBuildVariant("store");
			_setAppBundleRootForTests(contents);
			expect(() => assertDlopenPathAllowed("")).toThrow(
				/Refusing to dlopen empty path/,
			);
		});

		(isDarwin ? it : it.skip)(
			"is a no-op when no bundle root is resolvable (dev/source-tree run)",
			() => {
				setBuildVariant("store");
				// Clearing the override returns the resolver to execPath-based
				// resolution. In CI / a source checkout, process.execPath is
				// not under any .app, so the gate must not break the run.
				_setAppBundleRootForTests(null);
				expect(() =>
					assertDlopenPathAllowed("/tmp/anything.dylib"),
				).not.toThrow();
				expect(() => assertDlopenPathAllowed("")).not.toThrow();
			},
		);
	});

	describe("store build on non-darwin", () => {
		// Skipped on darwin: we cannot stub `process.platform` (the value is
		// baked into the module-load decision in getBundleContentsRoot); we
		// document the no-op behavior here and rely on the platform check at
		// the top of assertDlopenPathAllowed.
		(process.platform === "darwin" ? it.skip : it)(
			"is a no-op (only darwin enforces library validation in this iteration)",
			() => {
				setBuildVariant("store");
				expect(() =>
					assertDlopenPathAllowed("/tmp/anything.dylib"),
				).not.toThrow();
				expect(() => assertDlopenPathAllowed("")).not.toThrow();
			},
		);
	});

	describe("isPathInsideAppBundle", () => {
		const isDarwin = process.platform === "darwin";

		(isDarwin ? it : it.skip)(
			"returns true for paths inside the resolved bundle",
			() => {
				const { contents } = makeFakeBundle();
				_setAppBundleRootForTests(contents);
				expect(
					isPathInsideAppBundle(join(contents, "MacOS", "libCore.dylib")),
				).toBe(true);
			},
		);

		(isDarwin ? it : it.skip)("returns false for paths outside the bundle", () => {
			const { contents } = makeFakeBundle();
			_setAppBundleRootForTests(contents);
			expect(isPathInsideAppBundle(`${tmpdir()}${sep}evil.dylib`)).toBe(false);
		});

		(isDarwin ? it : it.skip)("returns false for relative paths", () => {
			const { contents } = makeFakeBundle();
			_setAppBundleRootForTests(contents);
			expect(isPathInsideAppBundle("./lib.dylib")).toBe(false);
		});

		(isDarwin ? it : it.skip)("returns false when no bundle is resolvable", () => {
			_setAppBundleRootForTests(null);
			expect(
				isPathInsideAppBundle("/Applications/Eliza.app/Contents/lib"),
			).toBe(false);
		});
	});
});
