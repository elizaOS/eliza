/** Covers host lib-target resolution and bundle lib-file selection/staging naming for the FFI backend. Deterministic. */
import { describe, expect, it } from "vitest";
import {
	libStagedName,
	resolveHostLibTargets,
	selectBundleLibFiles,
} from "./lib-target";
import { Eliza1LibFileEntrySchema } from "./manifest";

const SHA = "a".repeat(64);
const entry = (target: string, p: string, name?: string) => ({
	target,
	path: p,
	sha256: SHA,
	...(name ? { name } : {}),
});

describe("resolveHostLibTargets", () => {
	it("pins to ELIZA_INFERENCE_LIB_TARGET when set", () => {
		expect(
			resolveHostLibTargets({
				env: { ELIZA_INFERENCE_LIB_TARGET: "win-x64-cuda" },
				platform: "linux",
				arch: "x64",
			}),
		).toEqual(["win-x64-cuda"]);
	});

	it("returns [] on mobile (phones ship the lib natively)", () => {
		expect(
			resolveHostLibTargets({
				env: { ELIZA_PLATFORM: "android" },
				platform: "linux",
				arch: "arm64",
			}),
		).toEqual([]);
		expect(
			resolveHostLibTargets({
				env: { ELIZA_PLATFORM: "ios" },
				platform: "darwin",
				arch: "arm64",
			}),
		).toEqual([]);
	});

	it("maps darwin/arm64 to the metal set first (metal carries CPU fallback)", () => {
		expect(
			resolveHostLibTargets({ env: {}, platform: "darwin", arch: "arm64" }),
		).toEqual(["darwin-arm64-metal", "darwin-arm64-cpu", "darwin-arm64"]);
	});

	it("prefers CPU on win32 by default, GPU when preferGpu", () => {
		expect(
			resolveHostLibTargets({ env: {}, platform: "win32", arch: "x64" }),
		).toEqual(["win-x64-cpu", "win-x64", "win-x64-cuda"]);
		expect(
			resolveHostLibTargets({
				env: {},
				platform: "win32",
				arch: "x64",
				preferGpu: true,
			}),
		).toEqual(["win-x64-cuda", "win-x64-cpu", "win-x64"]);
	});

	it("maps linux/x64", () => {
		expect(
			resolveHostLibTargets({ env: {}, platform: "linux", arch: "x64" }),
		).toEqual(["linux-x64-cpu", "linux-x64", "linux-x64-cuda"]);
	});
});

describe("selectBundleLibFiles", () => {
	it("returns null when the bundle has no lib[]", () => {
		expect(selectBundleLibFiles({ files: {} }, ["win-x64-cpu"])).toBeNull();
		expect(
			selectBundleLibFiles({ files: { lib: [] } }, ["win-x64-cpu"]),
		).toBeNull();
	});

	it("returns null when no host target matches", () => {
		expect(
			selectBundleLibFiles(
				{ files: { lib: [entry("linux-x64-cpu", "lib/x.so")] } },
				["win-x64-cpu", "win-x64"],
			),
		).toBeNull();
	});

	it("picks the first matching target in preference order, with all its files", () => {
		const lib = [
			entry("win-x64-cpu", "lib/cpu/elizainference.dll"),
			entry("win-x64-cpu", "lib/cpu/ggml.dll"),
			entry("win-x64-cuda", "lib/cuda/elizainference.dll"),
		];
		const cudaFirst = selectBundleLibFiles({ files: { lib } }, [
			"win-x64-cuda",
			"win-x64-cpu",
		]);
		expect(cudaFirst?.target).toBe("win-x64-cuda");
		expect(cudaFirst?.files).toHaveLength(1);

		const cpuFirst = selectBundleLibFiles({ files: { lib } }, [
			"win-x64-cpu",
			"win-x64-cuda",
		]);
		expect(cpuFirst?.target).toBe("win-x64-cpu");
		expect(cpuFirst?.files).toHaveLength(2);
	});
});

describe("libStagedName", () => {
	it("uses the basename of path", () => {
		expect(libStagedName(entry("t", "lib/win-x64/elizainference.dll"))).toBe(
			"elizainference.dll",
		);
	});

	it("prefers name when set, reduced to a basename (no path traversal)", () => {
		expect(libStagedName(entry("t", "a/b.dll", "custom.dll"))).toBe(
			"custom.dll",
		);
		expect(libStagedName(entry("t", "a/b.dll", "../../evil.dll"))).toBe(
			"evil.dll",
		);
	});
});

describe("Eliza1LibFileEntrySchema", () => {
	it("accepts a valid platform-targeted lib entry", () => {
		const e = Eliza1LibFileEntrySchema.parse({
			path: "lib/win-x64/elizainference.dll",
			sha256: SHA,
			target: "win-x64-cpu",
			name: "elizainference.dll",
		});
		expect(e.target).toBe("win-x64-cpu");
		expect(e.name).toBe("elizainference.dll");
	});

	it("requires a target", () => {
		expect(() =>
			Eliza1LibFileEntrySchema.parse({ path: "x", sha256: SHA }),
		).toThrow();
	});
});
