/**
 * WS3 sd-cpp probe + backend availability tests.
 *
 * Covers two related surfaces:
 *
 *   1. `scripts/probe-sd-cpp.mjs` — onboarding probe used by the
 *      Settings flow and CI bundle-prep. Forks the script under both
 *      "binary missing" (SD_CPP_BIN points at a path that doesn't
 *      exist) and "binary available" (SD_CPP_BIN points at a tiny shell
 *      stub that prints a fake version line) regimes; asserts the JSON
 *      shape the runtime depends on.
 *
 *   2. `services/imagegen/sd-cpp.ts` — the `loadSdCppImageGenBackend`
 *      load path. Confirms that when the binary is missing it raises a
 *      structured `ImageGenBackendUnavailableError` with
 *      reason="binary_missing" / "subprocess_failed", and that the
 *      selector caller can detect the failure without an exception
 *      bleeding through.
 *
 * Why both layers in one file: the probe and the runtime share the same
 * binary-resolution rules (env var → PATH); a regression in one almost
 * always tracks a regression in the other.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	ImageGenBackendUnavailableError,
	isImageGenUnavailable,
} from "../src/services/imagegen/errors";
import { loadSdCppImageGenBackend } from "../src/services/imagegen/sd-cpp";

const PROBE_SCRIPT = fileURLToPath(
	new URL("../scripts/probe-sd-cpp.mjs", import.meta.url),
);

interface ProbeResult {
	available: boolean;
	binary: string;
	version?: string;
	supportedModels?: string[];
	accelerators?: string[];
	reason?: string;
	hint?: string;
}

function runProbe(env: Record<string, string | undefined>): ProbeResult {
	const result = spawnSync("node", [PROBE_SCRIPT], {
		env: { ...process.env, ...env },
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(
			`probe-sd-cpp exited with ${result.status}: ${result.stderr}`,
		);
	}
	const stdout = result.stdout.trim();
	const firstLine = stdout.split("\n").find((line) => line.trim().length > 0);
	if (!firstLine) {
		throw new Error("probe-sd-cpp produced no output");
	}
	return JSON.parse(firstLine) as ProbeResult;
}

describe("WS3 sd-cpp probe — onboarding script", () => {
	it("reports unavailable when SD_CPP_BIN points at a missing path", () => {
		const probe = runProbe({
			SD_CPP_BIN: "/definitely/does/not/exist/sd-fake-bin",
		});
		expect(probe.available).toBe(false);
		expect(probe.binary).toBe("/definitely/does/not/exist/sd-fake-bin");
		expect(probe.reason).toBe("binary_missing");
		expect(typeof probe.hint).toBe("string");
		expect(probe.hint).toMatch(/SD_CPP_BIN|stable-diffusion\.cpp/i);
		expect(probe.version).toBeUndefined();
		expect(probe.supportedModels).toBeUndefined();
	});

	it("reports available when SD_CPP_BIN points at a binary that returns version", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-cpp-probe-"));
		const fakeBin = join(dir, "fake-sd");
		writeFileSync(
			fakeBin,
			"#!/usr/bin/env bash\nif [ \"$1\" = \"--version\" ]; then echo 'stable-diffusion.cpp test-build-001'; exit 0; fi\nexit 2\n",
		);
		chmodSync(fakeBin, 0o755);
		const probe = runProbe({ SD_CPP_BIN: fakeBin });
		expect(probe.available).toBe(true);
		expect(probe.binary).toBe(fakeBin);
		expect(probe.version).toBe("stable-diffusion.cpp test-build-001");
		expect(Array.isArray(probe.supportedModels)).toBe(true);
		expect(probe.supportedModels).toContain("imagegen-sd-1_5-q5_0");
		expect(probe.supportedModels).toContain(
			"imagegen-z-image-turbo-q4_k_m",
		);
		expect(Array.isArray(probe.accelerators)).toBe(true);
		expect(probe.accelerators).toContain("cuda");
		expect(probe.accelerators).toContain("vulkan");
		expect(probe.accelerators).toContain("cpu");
	});

	it("reports binary_version_mismatch when the binary exits non-zero on --version", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-cpp-probe-"));
		const fakeBin = join(dir, "fake-sd-broken");
		writeFileSync(fakeBin, "#!/usr/bin/env bash\nexit 7\n");
		chmodSync(fakeBin, 0o755);
		const probe = runProbe({ SD_CPP_BIN: fakeBin });
		expect(probe.available).toBe(false);
		expect(probe.binary).toBe(fakeBin);
		expect(probe.reason).toBe("binary_version_mismatch");
	});
});

describe("WS3 sd-cpp backend — binary missing yields structured error", () => {
	it("loadSdCppImageGenBackend with a bogus binary path throws ImageGenBackendUnavailableError", async () => {
		await expect(
			loadSdCppImageGenBackend({
				modelKey: "imagegen-sd-1_5-q5_0",
				loadArgs: {
					modelPath: "/tmp/this-model-does-not-exist.gguf",
				},
				binaryPath: "/definitely/does/not/exist/sd-fake-bin",
			}),
		).rejects.toSatisfy((err: unknown) => {
			if (!(err instanceof ImageGenBackendUnavailableError)) return false;
			if (!isImageGenUnavailable(err)) return false;
			if (err.backendId !== "sd-cpp") return false;
			// ENOENT from spawn() gets wrapped into binary_missing.
			return err.reason === "binary_missing";
		});
	});

	it("error message references SD_CPP_BIN so onboarding can surface a fix", async () => {
		try {
			await loadSdCppImageGenBackend({
				modelKey: "imagegen-sd-1_5-q5_0",
				loadArgs: {
					modelPath: "/tmp/this-model-does-not-exist.gguf",
				},
				binaryPath: "/definitely/does/not/exist/sd-fake-bin",
			});
			expect.fail("loadSdCppImageGenBackend should have thrown");
		} catch (err) {
			if (!(err instanceof ImageGenBackendUnavailableError)) throw err;
			expect(err.message).toMatch(/SD_CPP_BIN/);
		}
	});

	it("backend honors a stub binary + fakeImageBytes to bypass the spawn", async () => {
		// Same shape sd-cpp.ts uses internally for the test seam: when
		// fakeImageBytes is provided, the load path skips --version and
		// generate writes the bytes directly. This is what
		// imagegen-handler.test.ts exercises in its end-to-end stub.
		const fakePng = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
			0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
			0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
			0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
			0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54,
			0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05,
			0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
			0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
			0xae, 0x42, 0x60, 0x82,
		]);
		const backend = await loadSdCppImageGenBackend({
			modelKey: "imagegen-sd-1_5-q5_0",
			loadArgs: { modelPath: "/tmp/not-read.gguf" },
			fakeImageBytes: fakePng,
		});
		expect(backend.id).toBe("sd-cpp");
		expect(backend.supports({ prompt: "x", width: 512, height: 512 })).toBe(
			true,
		);
		const result = await backend.generate({
			prompt: "a smiling cat",
			width: 512,
			height: 512,
			steps: 4,
			seed: 7,
		});
		expect(result.mime).toBe("image/png");
		expect(result.seed).toBe(7);
		expect(result.image[0]).toBe(0x89);
		expect(result.image[1]).toBe(0x50);
		await backend.dispose();
	});
});
