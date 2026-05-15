/**
 * TensorRT image-gen backend stub (WS3) — Windows NVIDIA.
 *
 * On Windows NVIDIA hosts, packaged `imagegen.exe` (built against
 * TensorRT 10.x with the Demo Diffusion plan) is the fastest path —
 * `nvidia/Stable-Diffusion-3.5-Medium-TensorRT` and the SDXL Turbo
 * TensorRT plans give a 2–4× speedup over sd-cpp + CUDA on the same
 * hardware.
 *
 * Why a child-process backend (and not TensorRT bindings):
 *   - TensorRT runtime is C++; a Node binding would require shipping a
 *     CUDA toolkit and a TensorRT runtime DLL on every Windows install,
 *     plus rebuilding when CUDA versions change.
 *   - The packaged `imagegen.exe` is a thin wrapper around the official
 *     Demo Diffusion sample. The bundle installer drops it at
 *     `${MODELS_DIR}/bin/imagegen.exe` alongside the TensorRT plan files.
 *   - Subprocess cost is negligible relative to inference time (≈10ms
 *     spawn vs ≈400ms inference).
 *
 * Binary resolution:
 *   1. `opts.binaryPath` (test injection).
 *   2. `process.env.IMAGEGEN_TRT_BIN` (operator override).
 *   3. `${MODELS_DIR}/bin/imagegen.exe`.
 *
 * Plan file resolution:
 *   The packaged binary expects a `--plan <path>` flag pointing at the
 *   prebuilt TensorRT engine for the active resolution. The catalog
 *   binds tier → plan; the installer materializes them under
 *   `${MODELS_DIR}/imagegen/trt-plans/<modelKey>/`.
 *
 * Until the bundle installer + packaged binary land for Windows NVIDIA,
 * `loadTensorRtImageGenBackend` throws `ImageGenBackendUnavailableError`
 * and the selector falls through to sd-cpp.
 *
 * Publishing pipeline (Windows x86_64 NVIDIA only):
 *
 *   Build (`imagegen.exe`):
 *     git clone https://github.com/NVIDIA/TensorRT && cd TensorRT/demo/Diffusion
 *     # Build against TensorRT 10.x + CUDA 12.x
 *     pip install -r requirements.txt
 *     python build.py --hf-token <ci-secret> \
 *       --version 1.5 --denoising-steps 20 \
 *       --build-static-batch --output-dir ../../../build/imagegen-sd15
 *     # Thin wrapper produces imagegen.exe linking against
 *     # nvinfer_10.dll + cudart64_12.dll; pyinstaller-onefile produces a
 *     # 35-MB executable next to the static .plan files.
 *   Build TensorRT plan (per resolution, per model):
 *     trtexec --onnx=unet.onnx --saveEngine=unet.plan --fp16 \
 *       --minShapes=sample:1x4x64x64 --optShapes=sample:1x4x64x64 \
 *       --maxShapes=sample:1x4x64x64
 *     # Drop plan files under imagegen/trt-plans/<modelKey>/{unet,vae,clip}.plan.
 *   Sign:
 *     signtool sign /tr http://timestamp.digicert.com /td sha256 \
 *       /fd sha256 /sha1 <eliza-labs-cert-thumbprint> imagegen.exe
 *     # SmartScreen reputation builds over the first ~1000 installs;
 *     # submit to Microsoft Defender Bytes-for-Bots if a new cert.
 *   Drop:
 *     releases.elizaos.ai/imagegen-trt/<version>/windows-x86_64/imagegen.exe
 *     releases.elizaos.ai/imagegen-trt/<version>/windows-x86_64/plans/
 *       sd-1.5-512x512/{unet,vae,clip}.plan
 *       sdxl-turbo-1024x1024/{unet,vae,clip}.plan
 *   The bundle installer writes the binary to
 *   `${MODELS_DIR}/bin/imagegen.exe` and the plans under
 *   `${MODELS_DIR}/imagegen/trt-plans/<modelKey>/`.
 *
 * Notarization:
 *   N/A on Windows; SmartScreen reputation replaces the macOS notarize
 *   step. Authenticode-signed binaries with a valid EV cert clear without
 *   warning on first launch.
 */

import { existsSync, promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageGenBackendUnavailableError } from "./errors";
import {
	assertPngOutput,
	defaultSpawn,
	resolveSeed,
	type SdCppSpawnLike,
} from "./sd-cpp";
import type {
	ImageGenBackend,
	ImageGenLoadArgs,
	ImageGenResult,
} from "./types";

export interface TensorRtBackendOptions {
	loadArgs: ImageGenLoadArgs;
	modelKey: string;
	binaryPath?: string;
	outputDir?: string;
	spawnImpl?: SdCppSpawnLike;
	fakeImageBytes?: Uint8Array;
	now?: () => number;
}

const DEFAULT_BIN = "imagegen.exe";

export async function loadTensorRtImageGenBackend(
	opts: TensorRtBackendOptions,
): Promise<ImageGenBackend> {
	const binary = resolveBinary(opts.binaryPath);
	const now = opts.now ?? Date.now;

	if (!opts.fakeImageBytes) {
		// On non-Windows platforms there's nothing to even try; surface
		// the unavailability cleanly so the selector moves on.
		if (process.platform !== "win32" && !opts.binaryPath) {
			throw new ImageGenBackendUnavailableError(
				"tensorrt",
				"unsupported_runtime",
				`[imagegen/tensorrt] TensorRT backend is Windows-only; current platform: ${process.platform}`,
			);
		}
		await assertBinaryAvailable(binary, opts.spawnImpl);
		if (!existsSync(opts.loadArgs.modelPath)) {
			throw new ImageGenBackendUnavailableError(
				"tensorrt",
				"model_missing",
				`[imagegen/tensorrt] TensorRT plan not found: ${opts.loadArgs.modelPath}`,
			);
		}
	}

	const outputDir =
		opts.outputDir ?? mkdtempSync(join(tmpdir(), "trt-imagegen-"));
	let disposed = false;

	return {
		id: "tensorrt",
		supports(req) {
			// TensorRT plans are compiled for a fixed resolution. The plan
			// file embeds the resolution; we accept any size and let the
			// binary error out — except we reject obviously bad inputs.
			const w = req.width ?? 1024;
			const h = req.height ?? 1024;
			if (w <= 0 || h <= 0) return false;
			if (w > 4096 || h > 4096) return false;
			return true;
		},
		async generate(req): Promise<ImageGenResult> {
			if (disposed) {
				throw new ImageGenBackendUnavailableError(
					"tensorrt",
					"binding_unavailable",
					"[imagegen/tensorrt] generate called after dispose()",
				);
			}
			if (!req.prompt?.trim()) {
				throw new ImageGenBackendUnavailableError(
					"tensorrt",
					"unsupported_request",
					"[imagegen/tensorrt] prompt is empty",
				);
			}
			const seed = resolveSeed(req.seed);
			const width = req.width ?? 1024;
			const height = req.height ?? 1024;
			const steps = req.steps ?? 25;
			const guidanceScale = req.guidanceScale ?? 4.0;
			const outputPath = join(outputDir, `out-${seed}-${now()}.png`);
			const startMs = now();

			if (opts.fakeImageBytes) {
				await fs.writeFile(outputPath, opts.fakeImageBytes);
				const elapsed = Math.max(1, now() - startMs);
				if (req.onProgressChunk)
					req.onProgressChunk({ step: steps, total: steps });
				return {
					image: opts.fakeImageBytes,
					mime: "image/png",
					seed,
					metadata: {
						model: opts.modelKey,
						prompt: req.prompt,
						steps,
						guidanceScale,
						inferenceTimeMs: elapsed,
					},
				};
			}

			const args = [
				"--plan",
				opts.loadArgs.modelPath,
				"--prompt",
				req.prompt,
				"--width",
				String(width),
				"--height",
				String(height),
				"--steps",
				String(steps),
				"--cfg",
				String(guidanceScale),
				"--seed",
				String(seed),
				"--output",
				outputPath,
			];
			if (req.negativePrompt) {
				args.push("--negative", req.negativePrompt);
			}

			await runTensorRt(binary, args, {
				signal: req.signal,
				spawnImpl: opts.spawnImpl,
			});

			const bytes = new Uint8Array(await fs.readFile(outputPath));
			assertPngOutput(bytes, "tensorrt", "subprocess_failed");
			const elapsed = Math.max(1, now() - startMs);
			return {
				image: bytes,
				mime: "image/png",
				seed,
				metadata: {
					model: opts.modelKey,
					prompt: req.prompt,
					steps,
					guidanceScale,
					inferenceTimeMs: elapsed,
				},
			};
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
		},
	};
}

function resolveBinary(override?: string): string {
	if (override) return override;
	const envBin = process.env.IMAGEGEN_TRT_BIN;
	if (envBin?.trim()) return envBin.trim();
	return DEFAULT_BIN;
}

async function assertBinaryAvailable(
	binary: string,
	spawnImpl?: SdCppSpawnLike,
): Promise<void> {
	try {
		const code = await new Promise<number | null>((resolve, reject) => {
			const proc = defaultSpawn(spawnImpl)(binary, ["--version"]);
			proc.on("error", (err: Error) => reject(err));
			proc.on("exit", (c: number | null) => resolve(c));
		});
		if (code !== 0) {
			throw new ImageGenBackendUnavailableError(
				"tensorrt",
				"binary_version_mismatch",
				`[imagegen/tensorrt] '${binary} --version' exited with code ${code}`,
			);
		}
	} catch (err) {
		if (err instanceof ImageGenBackendUnavailableError) throw err;
		const msg = err instanceof Error ? err.message : String(err);
		throw new ImageGenBackendUnavailableError(
			"tensorrt",
			"binary_missing",
			`[imagegen/tensorrt] cannot run '${binary} --version': ${msg}. Install the bundle's TensorRT imagegen package, or set IMAGEGEN_TRT_BIN to a built binary.`,
			{ cause: err },
		);
	}
}

async function runTensorRt(
	binary: string,
	args: readonly string[],
	opts: { signal?: AbortSignal; spawnImpl?: SdCppSpawnLike },
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const proc = defaultSpawn(opts.spawnImpl)(binary, args, {
			signal: opts.signal,
		});
		proc.on("error", (err: Error) => reject(err));
		proc.on("exit", (code: number | null) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(
				new ImageGenBackendUnavailableError(
					"tensorrt",
					"subprocess_failed",
					`[imagegen/tensorrt] imagegen.exe exited with code ${code}`,
				),
			);
		});
	});
}
