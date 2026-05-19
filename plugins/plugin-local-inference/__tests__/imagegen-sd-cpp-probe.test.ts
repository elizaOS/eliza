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
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	ImageGenBackendUnavailableError,
	isImageGenUnavailable,
} from "../src/services/imagegen/errors";
import {
	buildArgs,
	loadSdCppImageGenBackend,
} from "../src/services/imagegen/sd-cpp";

const PROBE_SCRIPT = fileURLToPath(
	new URL("../scripts/probe-sd-cpp.mjs", import.meta.url),
);

interface ProbeResult {
	available: boolean;
	binary: string;
	version?: string;
	supportedModels?: string[];
	accelerators?: string[];
	evidence?: string[];
	reason?: string;
	hint?: string;
}

function runProbe(env: Record<string, string | undefined>): ProbeResult {
	const nodeBin = process.env.NODE_BIN ?? process.env.NODE ?? "node";
	const mergedEnv = { ...process.env, ...env };
	const dir = mkdtempSync(join(tmpdir(), "sd-cpp-probe-out-"));
	const outPath = join(dir, "probe.json");
	const result =
		typeof Bun !== "undefined"
			? Bun.spawnSync({
					cmd: [nodeBin, PROBE_SCRIPT, "--json"],
					env: mergedEnv as Record<string, string>,
					stdout: Bun.file(outPath),
					stderr: "pipe",
				})
			: spawnSync(nodeBin, [PROBE_SCRIPT, "--json"], {
					env: mergedEnv,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				});
	const status = "exitCode" in result ? result.exitCode : result.status;
	const stdout = readFileSync(outPath, "utf8");
	const stderr =
		typeof result.stderr === "string"
			? result.stderr
			: new TextDecoder().decode(result.stderr ?? new Uint8Array());
	if (status !== 0) {
		throw new Error(
			`probe-sd-cpp exited with ${status}: ${stderr}`,
		);
	}
	const trimmed = stdout.trim();
	const firstLine = trimmed.split("\n").find((line) => line.trim().length > 0);
	if (!firstLine) {
		throw new Error(
			`probe-sd-cpp produced no output (status=${status}, stderr=${JSON.stringify(stderr)}, stdout=${JSON.stringify(stdout)})`,
		);
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

	it("reports CPU-only when the binary returns version but no CUDA proof", () => {
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
		expect(probe.accelerators).not.toContain("cuda");
		expect(probe.accelerators).toContain("cpu");
	});

	it("does not treat generic --rng cuda help text as CUDA build proof", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-cpp-probe-"));
		const fakeBin = join(dir, "fake-sd-metal");
		writeFileSync(
			fakeBin,
			[
				"#!/usr/bin/env bash",
				"if [ \"$1\" = \"--version\" ]; then echo 'stable-diffusion.cpp test-build-metal'; exit 0; fi",
				"if [ \"$1\" = \"--help\" ]; then echo '--rng cuda, default, consistent with webui GPU RNG'; echo 'backend: Metal'; exit 0; fi",
				"exit 2",
				"",
			].join("\n"),
		);
		chmodSync(fakeBin, 0o755);
		const probe = runProbe({ SD_CPP_BIN: fakeBin });
		expect(probe.available).toBe(true);
		expect(probe.accelerators).toContain("metal");
		expect(probe.accelerators).not.toContain("cuda");
	});

	it("reports CUDA when help/version proves a CUDA-capable binary", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-cpp-probe-"));
		const fakeBin = join(dir, "fake-sd-cuda");
		writeFileSync(
			fakeBin,
			[
				"#!/usr/bin/env bash",
				"if [ \"$1\" = \"--version\" ]; then echo 'stable-diffusion.cpp test-build-002 SD_CUDA=ON'; exit 0; fi",
				"if [ \"$1\" = \"--help\" ]; then echo 'build: CUDA cuBLAS'; exit 0; fi",
				"exit 2",
				"",
			].join("\n"),
		);
		chmodSync(fakeBin, 0o755);
		const probe = runProbe({ SD_CPP_BIN: fakeBin });
		expect(probe.available).toBe(true);
		expect(probe.accelerators).toContain("cuda");
		expect(probe.evidence).toContain("help_or_version");
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
			expect(isImageGenUnavailable(err)).toBe(true);
			expect(err.backendId).toBe("sd-cpp");
			// ENOENT from spawn() gets wrapped into binary_missing.
			expect(err.reason).toBe("binary_missing");
		}
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

	it("rejects CUDA load when the sd-cpp binary is CPU-only", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-cpp-probe-"));
		const fakeBin = join(dir, "fake-sd-cpu");
		writeFileSync(
			fakeBin,
			"#!/usr/bin/env bash\nif [ \"$1\" = \"--version\" ]; then echo 'stable-diffusion.cpp cpu-only'; exit 0; fi\nif [ \"$1\" = \"--help\" ]; then echo 'stable-diffusion.cpp help'; exit 0; fi\nexit 2\n",
		);
		chmodSync(fakeBin, 0o755);
		try {
			await loadSdCppImageGenBackend({
				modelKey: "imagegen-sd-1_5-q5_0",
				loadArgs: {
					modelPath: "/tmp/this-model-does-not-exist.gguf",
					accelerator: "cuda",
				},
				binaryPath: fakeBin,
			});
			expect.fail("loadSdCppImageGenBackend should have thrown");
		} catch (err) {
			if (!(err instanceof ImageGenBackendUnavailableError)) throw err;
			expect(err.backendId).toBe("sd-cpp");
			expect(err.reason).toBe("cuda_binary_missing");
			expect(err.message).toMatch(/CUDA support/);
		}
	});

	it("accepts CUDA load when sidecar manifest proves CUDA support", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-cpp-probe-"));
		const fakeBin = join(dir, "fake-sd-cuda");
		const fakeModel = join(dir, "model.gguf");
		writeFileSync(fakeModel, "fake model");
		writeFileSync(
			join(dir, "sd-cpp.manifest.json"),
			JSON.stringify({ accelerators: ["cuda"] }),
		);
		writeFileSync(
			fakeBin,
			[
				"#!/usr/bin/env bash",
				"if [ \"$1\" = \"--version\" ]; then echo 'stable-diffusion.cpp SD_CUDA=ON'; exit 0; fi",
				"if [ \"$1\" = \"--help\" ]; then echo 'backend: CUDA cuBLAS'; exit 0; fi",
				"exit 2",
				"",
			].join("\n"),
		);
		chmodSync(fakeBin, 0o755);
		const backend = await loadSdCppImageGenBackend({
			modelKey: "imagegen-sd-1_5-q5_0",
			loadArgs: { modelPath: fakeModel, accelerator: "cuda" },
			binaryPath: fakeBin,
		});
		expect(backend.id).toBe("sd-cpp");
		await backend.dispose();
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

describe("WS3 sd-cpp backend — CLI argument contract", () => {
	const baseArgs = {
		modelPath: "/models/imagegen/sd-1.5-Q5_0.gguf",
		prompt: "a small workspace",
		width: 64,
		height: 64,
		steps: 1,
		guidanceScale: 7.5,
		seed: 42,
		output: "/tmp/out.png",
	};

	it("uses --model for monolithic SD-family checkpoints", () => {
		const args = buildArgs(baseArgs);
		expect(args.slice(0, 2)).toEqual([
			"--model",
			"/models/imagegen/sd-1.5-Q5_0.gguf",
		]);
		expect(args).not.toContain("--diffusion-model");
	});

	it("uses --diffusion-model with split Z-Image companion assets", () => {
		const args = buildArgs({
			...baseArgs,
			modelPath: "/models/imagegen/z-image-turbo-Q4_K_M.gguf",
			splitDiffusionModel: true,
			vae: "/models/imagegen/vae/ae.safetensors",
			llm: "/models/imagegen/text-encoders/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
		});
		expect(args.slice(0, 2)).toEqual([
			"--diffusion-model",
			"/models/imagegen/z-image-turbo-Q4_K_M.gguf",
		]);
		expect(args).toContain("--vae");
		expect(args).toContain("/models/imagegen/vae/ae.safetensors");
		expect(args).toContain("--llm");
		expect(args).toContain(
			"/models/imagegen/text-encoders/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
		);
		expect(args).not.toContain("--model");
	});

	it("uses current upstream backend flags for CPU and Vulkan", () => {
		expect(buildArgs({ ...baseArgs, accelerator: "cpu" })).toEqual(
			expect.arrayContaining([
				"--backend",
				"cpu",
				"--params-backend",
				"cpu",
			]),
		);
		expect(buildArgs({ ...baseArgs, accelerator: "vulkan" })).toEqual(
			expect.arrayContaining(["--backend", "vulkan0"]),
		);
	});
});
