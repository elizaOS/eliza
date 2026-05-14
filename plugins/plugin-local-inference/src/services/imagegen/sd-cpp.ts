/**
 * stable-diffusion.cpp image-gen backend (WS3) — Linux + Windows
 * (CPU/CUDA/Vulkan), and Android NDK builds reuse the same binary via
 * `plugin-aosp-local-inference`'s JNI bridge.
 *
 * Why a child-process backend (and not a Node binding):
 *
 *   - stable-diffusion.cpp ships a single CLI binary (`sd`) per build
 *     flavour (CPU / CUDA / Vulkan / Metal). Linking it as a Node addon
 *     would require maintaining a parallel build matrix to llama.cpp;
 *     we instead reuse the same binary shipped by the bundle installer.
 *   - The CLI is stable across versions (b8198+ has matched the same
 *     `--model …` / `--prompt …` / `-o …` surface for over a year), so
 *     contract drift is unlikely.
 *   - Diffusion runs in seconds, not milliseconds; the subprocess
 *     spawn cost is negligible relative to inference time.
 *
 * Binary resolution order:
 *
 *   1. `opts.binaryPath` (test injection, explicit override).
 *   2. `process.env.SD_CPP_BIN` (operator override).
 *   3. `${MODELS_DIR}/bin/sd` (default install path; the bundle drops
 *      the binary here on first activation of an image-gen tier).
 *
 * Availability is checked at load time by spawning the binary with
 * `--version`. Failure (ENOENT, non-zero exit, version-parse failure)
 * is reported as a structured `ImageGenBackendUnavailableError` so the
 * selector falls through to the next backend.
 *
 * Accelerator flags (from `ImageGenLoadArgs.accelerator`):
 *
 *   - `"cuda"`  → no extra flag; relies on the CUDA-built binary.
 *   - `"vulkan"` → `--vulkan` (works on AMD + Intel + NV Vulkan paths).
 *   - `"cpu"`   → `--cpu` (forces CPU even on a GPU-built binary).
 *   - `"auto"`  → no extra flag; the binary's own auto-detection runs.
 *
 * GPU validation status (this host has no GPU):
 *   The contract here is binary surface only. CUDA / Vulkan smoke tests
 *   run on real hardware as part of the WS5 e2e gate; documented at the
 *   bottom of `__tests__/imagegen-handler.test.ts`.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageGenBackendUnavailableError } from "./errors";
import type {
	ImageGenBackend,
	ImageGenLoadArgs,
	ImageGenRequest,
	ImageGenResult,
} from "./types";

/**
 * Optional test seam. Production code uses Node's `child_process.spawn`;
 * tests inject a fake to drive deterministic outputs without forking.
 */
export interface SdCppSpawnLike {
	(
		command: string,
		args: readonly string[],
		options?: { signal?: AbortSignal; cwd?: string },
	): {
		stdout: AsyncIterable<Buffer> | NodeJS.ReadableStream | null;
		stderr: AsyncIterable<Buffer> | NodeJS.ReadableStream | null;
		on(event: "exit", listener: (code: number | null) => void): unknown;
		on(event: "error", listener: (err: Error) => void): unknown;
		kill?(signal?: NodeJS.Signals): void;
	};
}

export interface SdCppBackendOptions {
	loadArgs: ImageGenLoadArgs;
	/** Catalog key — copied into `ImageGenResult.metadata.model`. */
	modelKey: string;
	/** Override the binary path. Useful for tests. */
	binaryPath?: string;
	/**
	 * Override the on-disk output directory. Defaults to a fresh dir
	 * under `os.tmpdir()`. Tests can pin this so the deterministic
	 * fixture is read from a known path.
	 */
	outputDir?: string;
	/** Spawn implementation. Defaults to Node's `child_process.spawn`. */
	spawnImpl?: SdCppSpawnLike;
	/**
	 * For tests: instead of running the binary, write `fakeImageBytes`
	 * to the output file and return it. When set, `binaryPath` and
	 * version-probing are skipped.
	 */
	fakeImageBytes?: Uint8Array;
	/**
	 * For tests: override `Date.now` so timing assertions are stable.
	 */
	now?: () => number;
}

const DEFAULT_BIN = "sd";

/**
 * Load (or in this case, "smoke-check") the sd-cpp backend. The binary
 * lives out-of-process; "loading" is verifying it exists and runs.
 * The actual model weights are passed per-call as `--model <path>`,
 * so the same binary serves multiple GGUFs without an explicit unload
 * step.
 */
export async function loadSdCppImageGenBackend(
	opts: SdCppBackendOptions,
): Promise<ImageGenBackend> {
	const binary = resolveBinaryPath(opts.binaryPath);
	const now = opts.now ?? Date.now;

	if (!opts.fakeImageBytes) {
		// Smoke-check: run `--version` so we fail fast instead of waiting
		// for the first real generate.
		await assertBinaryAvailable(binary, opts.spawnImpl);
	}

	// Ensure the model file exists. Caller resolves the path through
	// the bundle installer; we just gate on its presence so a missing
	// weight surfaces here instead of from the binary stderr.
	if (!opts.fakeImageBytes && !existsSync(opts.loadArgs.modelPath)) {
		throw new ImageGenBackendUnavailableError(
			"sd-cpp",
			"model_missing",
			`[imagegen/sd-cpp] model not found: ${opts.loadArgs.modelPath}`,
		);
	}

	const outputDir = opts.outputDir ?? mkdtempSync(join(tmpdir(), "sdcpp-"));
	let disposed = false;

	return {
		id: "sd-cpp",
		supports(req) {
			// sd-cpp accepts any reasonable WxH (rounded to /8). Reject
			// obviously bad inputs so the selector keeps walking.
			const w = req.width ?? 512;
			const h = req.height ?? 512;
			if (w <= 0 || h <= 0) return false;
			if (w > 4096 || h > 4096) return false;
			return true;
		},
		async generate(req): Promise<ImageGenResult> {
			if (disposed) {
				throw new ImageGenBackendUnavailableError(
					"sd-cpp",
					"subprocess_failed",
					"[imagegen/sd-cpp] generate called after dispose()",
				);
			}
			if (!req.prompt || !req.prompt.trim()) {
				throw new ImageGenBackendUnavailableError(
					"sd-cpp",
					"unsupported_request",
					"[imagegen/sd-cpp] prompt is empty",
				);
			}
			const seed =
				typeof req.seed === "number" && req.seed >= 0
					? req.seed
					: pickSeed();
			const width = req.width ?? 512;
			const height = req.height ?? 512;
			const steps = req.steps ?? 20;
			const guidanceScale = req.guidanceScale ?? 7.5;
			const outputPath = join(outputDir, `out-${seed}-${now()}.png`);
			const startMs = now();

			if (opts.fakeImageBytes) {
				// Test path: skip the subprocess entirely. The deterministic
				// stub is what `__tests__/imagegen-handler.test.ts` uses.
				await fs.writeFile(outputPath, opts.fakeImageBytes);
				const elapsed = Math.max(1, now() - startMs);
				if (req.onProgressChunk) req.onProgressChunk({ step: steps, total: steps });
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

			const args = buildArgs({
				modelPath: opts.loadArgs.modelPath,
				vae: opts.loadArgs.vae,
				prompt: req.prompt,
				negativePrompt: req.negativePrompt,
				width,
				height,
				steps,
				guidanceScale,
				seed,
				scheduler: req.scheduler,
				output: outputPath,
				accelerator: opts.loadArgs.accelerator,
			});

			await runSdCpp(binary, args, {
				signal: req.signal,
				spawnImpl: opts.spawnImpl,
				onProgressChunk: req.onProgressChunk,
				totalSteps: steps,
			});

			const bytes = new Uint8Array(await fs.readFile(outputPath));
			// Defensive: if the binary wrote a non-PNG (e.g. someone passed
			// `-o foo.jpg`) we still report `image/png` because the catalog
			// pins PNG; mismatch is a configuration bug, not a runtime case.
			assertPngHeader(bytes);
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
			// Best-effort scratch cleanup. We don't fail dispose if the
			// temp dir is missing — it just means a prior caller already
			// removed it.
			await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
		},
	};
}

function resolveBinaryPath(override?: string): string {
	if (override) return override;
	const envBin = process.env.SD_CPP_BIN;
	if (envBin && envBin.trim()) return envBin.trim();
	return DEFAULT_BIN;
}

async function assertBinaryAvailable(
	binary: string,
	spawnImpl?: SdCppSpawnLike,
): Promise<void> {
	try {
		const code = await runSimple(binary, ["--version"], spawnImpl);
		if (code !== 0) {
			throw new ImageGenBackendUnavailableError(
				"sd-cpp",
				"binary_version_mismatch",
				`[imagegen/sd-cpp] '${binary} --version' exited with code ${code}`,
			);
		}
	} catch (err) {
		if (err instanceof ImageGenBackendUnavailableError) throw err;
		const message = err instanceof Error ? err.message : String(err);
		throw new ImageGenBackendUnavailableError(
			"sd-cpp",
			"binary_missing",
			`[imagegen/sd-cpp] cannot run '${binary} --version': ${message}. Set SD_CPP_BIN or install the bundle's image-gen binary.`,
			{ cause: err },
		);
	}
}

function runSimple(
	binary: string,
	args: readonly string[],
	spawnImpl?: SdCppSpawnLike,
): Promise<number | null> {
	return new Promise<number | null>((resolve, reject) => {
		const proc = (spawnImpl ?? (spawn as unknown as SdCppSpawnLike))(
			binary,
			args,
		);
		proc.on("error", (err: Error) => reject(err));
		proc.on("exit", (code: number | null) => resolve(code));
	});
}

async function runSdCpp(
	binary: string,
	args: readonly string[],
	opts: {
		signal?: AbortSignal;
		spawnImpl?: SdCppSpawnLike;
		onProgressChunk?: ImageGenRequest["onProgressChunk"];
		totalSteps: number;
	},
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const proc = (opts.spawnImpl ?? (spawn as unknown as SdCppSpawnLike))(
			binary,
			args,
			{ signal: opts.signal },
		);
		const stderr = proc.stderr;
		// stable-diffusion.cpp prints `step: N/M` lines to stderr at each
		// denoise iteration. Tail the stream and forward as progress chunks
		// when the caller asked for them. Tolerate non-stream stderr (the
		// test spawn may pass null) — progress is best-effort.
		if (opts.onProgressChunk && stderr && typeof (stderr as NodeJS.ReadableStream).on === "function") {
			let leftover = "";
			(stderr as NodeJS.ReadableStream).on("data", (chunk: Buffer | string) => {
				const text = leftover + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
				const lines = text.split(/\r?\n/);
				leftover = lines.pop() ?? "";
				for (const line of lines) {
					const m = line.match(/step:\s*(\d+)\s*\/\s*(\d+)/i);
					if (!m) continue;
					const step = Number(m[1]);
					const total = Number(m[2]) || opts.totalSteps;
					opts.onProgressChunk?.({ step, total });
				}
			});
		}
		proc.on("error", (err: Error) => reject(err));
		proc.on("exit", (code: number | null) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(
				new ImageGenBackendUnavailableError(
					"sd-cpp",
					"subprocess_failed",
					`[imagegen/sd-cpp] binary exited with code ${code}`,
				),
			);
		});
	});
}

function buildArgs(input: {
	modelPath: string;
	vae?: string;
	prompt: string;
	negativePrompt?: string;
	width: number;
	height: number;
	steps: number;
	guidanceScale: number;
	seed: number;
	scheduler?: string;
	output: string;
	accelerator?: ImageGenLoadArgs["accelerator"];
}): string[] {
	const args: string[] = [
		"--model", input.modelPath,
		"--prompt", input.prompt,
		"--width", String(input.width),
		"--height", String(input.height),
		"--steps", String(input.steps),
		"--cfg-scale", String(input.guidanceScale),
		"--seed", String(input.seed),
		"-o", input.output,
	];
	if (input.vae) {
		args.push("--vae", input.vae);
	}
	if (input.negativePrompt) {
		args.push("--negative-prompt", input.negativePrompt);
	}
	if (input.scheduler) {
		args.push("--sampling-method", input.scheduler);
	}
	if (input.accelerator === "vulkan") {
		args.push("--vulkan");
	} else if (input.accelerator === "cpu") {
		args.push("--cpu");
	}
	// `auto` / `cuda` / `metal` rely on the binary build's defaults.
	return args;
}

function pickSeed(): number {
	// 31-bit positive integer — sd-cpp stores seed as int32.
	return Math.floor(Math.random() * 0x7fffffff);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function assertPngHeader(bytes: Uint8Array): void {
	if (bytes.length < PNG_SIGNATURE.length) {
		throw new ImageGenBackendUnavailableError(
			"sd-cpp",
			"subprocess_failed",
			`[imagegen/sd-cpp] output too short (${bytes.length} bytes); not a PNG`,
		);
	}
	for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
		if (bytes[i] !== PNG_SIGNATURE[i]) {
			throw new ImageGenBackendUnavailableError(
				"sd-cpp",
				"subprocess_failed",
				"[imagegen/sd-cpp] output missing PNG signature; binary may have written a different format",
			);
		}
	}
}

export { PNG_SIGNATURE };
