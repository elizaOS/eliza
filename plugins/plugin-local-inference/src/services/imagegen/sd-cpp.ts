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
 *   - The CLI is stable across versions for monolithic SD checkpoints
 *     (`--model …` / `--prompt …` / `-o …`) and split diffusion assets
 *     (`--diffusion-model …` plus companion encoders / VAE), so contract
 *     drift is unlikely.
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
 * `--version`. CUDA loads also require explicit capability evidence from
 * an adjacent manifest, `--help`, or `--version`; a Linux NVIDIA GPU alone
 * is not evidence that the installed binary was compiled with CUDA.
 *
 * Accelerator flags (from `ImageGenLoadArgs.accelerator`):
 *
 *   - `"cuda"`  → no extra flag; relies on the CUDA-built binary.
 *   - `"vulkan"` → `--backend vulkan0` (works on AMD + Intel + NV Vulkan paths).
 *   - `"cpu"`   → `--backend cpu --params-backend cpu` (forces CPU).
 *   - `"auto"`  → no extra flag; the binary's own auto-detection runs.
 *
 * GPU validation status (this host has no GPU):
 *   The contract here is binary surface only. CUDA / Vulkan smoke tests
 *   run on real hardware as part of the WS5 e2e gate; documented at the
 *   bottom of `__tests__/imagegen-handler.test.ts`.
 *
 * Publishing pipeline (per platform):
 *
 *   Linux x86_64 (CUDA):
 *     git clone https://github.com/leejet/stable-diffusion.cpp && cd stable-diffusion.cpp \
 *       && cmake -B build -DSD_CUDA=ON -DCMAKE_BUILD_TYPE=Release \
 *       && cmake --build build --config Release -j
 *     Strip + tar; sign: not required (Linux). Drop into
 *     releases.elizaos.ai/sd-cpp/<version>/linux-x86_64-cuda/sd.tar.zst.
 *   Linux x86_64 (Vulkan):
 *     cmake -B build -DSD_VULKAN=ON -DCMAKE_BUILD_TYPE=Release && cmake --build build -j
 *   Linux x86_64 (CPU):
 *     cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j
 *   Windows x86_64 (CUDA):
 *     Same cmake invocation under MSVC 2022; produces sd.exe. Sign with the
 *     Eliza Labs EV cert (signtool sign /tr ...); submit to Microsoft
 *     SmartScreen if a new cert. Drop into releases.elizaos.ai/sd-cpp/
 *     <version>/windows-x86_64-cuda/sd.exe.
 *   Windows x86_64 (Vulkan, CPU): mirror the CUDA build with the matching
 *     cmake -DSD_VULKAN=ON / -DCMAKE_BUILD_TYPE=Release flags.
 *   Android (arm64-v8a JNI): cross-compile through the NDK against the
 *     same upstream; not consumed directly here — `plugin-aosp-local-inference`
 *     wraps it as `libstable-diffusion-jni.so` and the AOSP backend (see
 *     `aosp-unavailable.ts`) calls into it via the eliza-llama-shim FFI surface.
 *   macOS (Metal): cmake -B build -DSD_METAL=ON; codesign with the Eliza
 *     Labs Developer ID Application cert and notarize via `xcrun notarytool
 *     submit ...`; staple. Drop into releases.elizaos.ai/sd-cpp/<version>/
 *     darwin-{arm64,x86_64}/sd. macOS Apple Silicon prefers `mflux` over
 *     sd-cpp (see `mflux.ts`), but sd-cpp Metal is the fallback.
 *   Linux riscv64 (CPU): unavailable as a shipped binary. Cross-compile via
 *     `zig cc --target=riscv64-linux-musl` (same toolchain
 *     packages/app-core/scripts/aosp/compile-libllama.mjs uses).
 *     There is no Node/host build script for sd-cpp in this repo — sd-cpp
 *     is a child-process backend wrapping a precompiled `sd` binary
 *     fetched from releases.elizaos.ai. Wiring riscv64 is a CDN-side
 *     artifact addition (drop a `releases.elizaos.ai/sd-cpp/<version>/
 *     linux-riscv64-cpu/sd` build); no build-matrix entry needs to land
 *     here. Until then, the riscv64 binary-resolution attempt simply
 *     surfaces the same `ImageGenBackendUnavailableError("sd-cpp", ...)`
 *     it surfaces today on any host where the bundle installer did not
 *     stage `sd` — i.e. image-gen is silently disabled on riscv64
 *     (acceptable: the eliza-1 phone tier does not require image-gen).
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
export type SdCppSpawnLike = (
	command: string,
	args: readonly string[],
	options?: { signal?: AbortSignal; cwd?: string },
) => {
	stdout: AsyncIterable<Buffer> | NodeJS.ReadableStream | null;
	stderr: AsyncIterable<Buffer> | NodeJS.ReadableStream | null;
	on(event: "exit", listener: (code: number | null) => void): unknown;
	on(event: "close", listener: (code: number | null) => void): unknown;
	on(event: "error", listener: (err: Error) => void): unknown;
	kill?(signal?: NodeJS.Signals): void;
};

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
 * The actual model weights are passed per-call as either `--model <path>`
 * or `--diffusion-model <path>`, so the same binary serves multiple
 * GGUFs without an explicit unload step.
 */
export async function loadSdCppImageGenBackend(
	opts: SdCppBackendOptions,
): Promise<ImageGenBackend> {
	const binary = resolveBinaryPath(opts.binaryPath);
	const now = opts.now ?? Date.now;

	if (!opts.fakeImageBytes) {
		// Smoke-check: run `--version` so we fail fast instead of waiting
		// for the first real generate.
		await assertBinaryAvailable(
			binary,
			opts.loadArgs.accelerator,
			opts.spawnImpl,
		);
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
			if (!req.prompt.trim()) {
				throw new ImageGenBackendUnavailableError(
					"sd-cpp",
					"unsupported_request",
					"[imagegen/sd-cpp] prompt is empty",
				);
			}
			const seed = resolveSeed(req.seed);
			const width = req.width ?? 512;
			const height = req.height ?? 512;
			const steps = req.steps ?? 20;
			const guidanceScale = req.guidanceScale ?? 7.5;
			const outputPath = join(outputDir, `out-${seed}-${now()}.png`);
			const startMs = now();

			if (opts.fakeImageBytes) {
				// Test path: skip the subprocess entirely. The deterministic
				// in-memory bytes are what `__tests__/imagegen-handler.test.ts` uses.
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

			const args = buildArgs({
				modelPath: opts.loadArgs.modelPath,
				splitDiffusionModel: opts.loadArgs.splitDiffusionModel,
				vae: opts.loadArgs.vae,
				llm: opts.loadArgs.llm,
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
			assertPngOutput(bytes, "sd-cpp", "subprocess_failed");
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
			// error-policy:J6 best-effort teardown — scratch cleanup on dispose. We
			// don't fail dispose if the temp dir is missing; it just means a prior
			// caller already removed it.
			await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
		},
	};
}

function resolveBinaryPath(override?: string): string {
	if (override) return override;
	const envBin = process.env.SD_CPP_BIN;
	if (envBin?.trim()) return envBin.trim();
	return DEFAULT_BIN;
}

async function assertBinaryAvailable(
	binary: string,
	accelerator?: ImageGenLoadArgs["accelerator"],
	spawnImpl?: SdCppSpawnLike,
): Promise<void> {
	let version: SdCppCommandResult;
	try {
		version = await runCollect(binary, ["--version"], spawnImpl);
		if (version.code !== 0) {
			throw new ImageGenBackendUnavailableError(
				"sd-cpp",
				"binary_version_mismatch",
				`[imagegen/sd-cpp] '${binary} --version' exited with code ${version.code}`,
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
	if (
		accelerator === "cuda" ||
		accelerator === "vulkan" ||
		accelerator === "metal"
	) {
		const capabilities = await probeSdCppCapabilitiesFromBinary(
			binary,
			version,
			spawnImpl,
		);
		if (!capabilities.accelerators.includes(accelerator)) {
			throw new ImageGenBackendUnavailableError(
				"sd-cpp",
				`${accelerator}_binary_missing`,
				`[imagegen/sd-cpp] '${binary}' is available but does not prove ${accelerator.toUpperCase()} support via manifest, --help, or --version. Falling back from sd-cpp ${accelerator}; install a stable-diffusion.cpp ${accelerator.toUpperCase()} build or set SD_CPP_BIN to one.`,
			);
		}
	}
}

interface SdCppCommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function runCollect(
	binary: string,
	args: readonly string[],
	spawnImpl?: SdCppSpawnLike,
): Promise<SdCppCommandResult> {
	if (!spawnImpl) {
		return new Promise<SdCppCommandResult>((resolve, reject) => {
			execFile(binary, [...args], (error, stdout, stderr) => {
				const code =
					typeof (error as { code?: unknown } | null)?.code === "number"
						? (error as { code: number }).code
						: error
							? null
							: 0;
				if (error && code === null) {
					reject(error);
					return;
				}
				resolve({
					code,
					stdout: String(stdout),
					stderr: String(stderr),
				});
			});
		});
	}
	return new Promise<SdCppCommandResult>((resolve, reject) => {
		const proc = defaultSpawn(spawnImpl)(binary, args);
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			setTimeout(() => resolve({ code, stdout, stderr }), 0);
		};
		collectOutput(proc.stdout, (chunk) => {
			stdout += chunk;
		});
		collectOutput(proc.stderr, (chunk) => {
			stderr += chunk;
		});
		proc.on("error", (err: Error) => reject(err));
		if (typeof (proc as { on?: unknown }).on === "function") {
			try {
				proc.on("close", finish);
			} catch {
				// Test doubles may only implement the narrower SdCppSpawnLike
				// exit/error event set. The exit listener below still resolves.
			}
		}
		proc.on("exit", finish);
	});
}

function collectOutput(
	stream: AsyncIterable<Buffer> | NodeJS.ReadableStream | null,
	append: (chunk: string) => void,
): void {
	if (!stream) return;
	if (typeof (stream as NodeJS.ReadableStream).on === "function") {
		(stream as NodeJS.ReadableStream).on("data", (chunk: Buffer | string) => {
			append(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		});
		return;
	}
	void (async () => {
		for await (const chunk of stream as AsyncIterable<Buffer>) {
			append(chunk.toString("utf8"));
		}
	})();
}

type SdCppAccelerator = NonNullable<ImageGenLoadArgs["accelerator"]>;

export interface SdCppCapabilities {
	version: string | null;
	accelerators: readonly SdCppAccelerator[];
	evidence: readonly string[];
}

export async function probeSdCppCapabilitiesFromBinary(
	binary: string,
	versionResult?: SdCppCommandResult,
	spawnImpl?: SdCppSpawnLike,
): Promise<SdCppCapabilities> {
	const version =
		versionResult ?? (await runCollect(binary, ["--version"], spawnImpl));
	const help = await runCollect(binary, ["--help"], spawnImpl).catch(
		() => null,
	);
	const manifest = await readSdCppCapabilityManifest(binary);
	const textEvidence = [
		version.stdout,
		version.stderr,
		help?.stdout ?? "",
		help?.stderr ?? "",
	].join("\n");
	const accelerators = new Set<SdCppAccelerator>(["auto", "cpu"]);
	const evidence: string[] = [];
	for (const accelerator of manifest.accelerators) {
		accelerators.add(accelerator);
		evidence.push("manifest");
	}
	if (hasPositiveCudaEvidence(textEvidence)) {
		accelerators.add("cuda");
		evidence.push("help_or_version");
	}
	if (hasPositiveVulkanEvidence(textEvidence)) accelerators.add("vulkan");
	if (hasPositiveMetalEvidence(textEvidence)) accelerators.add("metal");
	return {
		version: parseVersionLine(version.stdout, version.stderr),
		accelerators: [...accelerators],
		evidence: [...new Set(evidence)],
	};
}

async function readSdCppCapabilityManifest(
	binary: string,
): Promise<{ accelerators: SdCppAccelerator[] }> {
	const candidates = [
		`${binary}.json`,
		`${binary}.manifest.json`,
		join(dirname(binary), `${basename(binary)}.manifest.json`),
		join(dirname(binary), "sd-cpp.manifest.json"),
		join(dirname(binary), "manifest.json"),
	];
	for (const candidate of [...new Set(candidates)]) {
		try {
			const parsed = JSON.parse(await fs.readFile(candidate, "utf8"));
			return { accelerators: extractAccelerators(parsed) };
		} catch {
			// Missing or malformed sidecar manifests are non-fatal; help/version
			// can still prove capability, and the caller will reject CUDA if not.
		}
	}
	return { accelerators: [] };
}

function extractAccelerators(value: unknown): SdCppAccelerator[] {
	const found = new Set<SdCppAccelerator>();
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		if (typeof node === "string") {
			const normalized = node.toLowerCase();
			if (isSdCppAccelerator(normalized)) found.add(normalized);
			return;
		}
		if (!node || typeof node !== "object") return;
		for (const [key, child] of Object.entries(node)) {
			const normalizedKey = key.toLowerCase();
			if (isSdCppAccelerator(normalizedKey) && child === true) {
				found.add(normalizedKey);
			}
			visit(child);
		}
	};
	visit(value);
	return [...found];
}

function isSdCppAccelerator(value: string): value is SdCppAccelerator {
	return (
		value === "cuda" ||
		value === "vulkan" ||
		value === "metal" ||
		value === "cpu"
	);
}

function hasPositiveCudaEvidence(text: string): boolean {
	const lower = text.toLowerCase();
	if (
		/(without|no|disabled|disable|not built with|unsupported)[^\n]{0,40}cuda/.test(
			lower,
		)
	) {
		return false;
	}
	return /(^|[^a-z0-9])(sd_cuda|ggml_cuda|cublas|cudart)([^a-z0-9]|$)/.test(
		lower,
	);
}

function hasPositiveVulkanEvidence(text: string): boolean {
	return /\b(sd_vulkan|ggml_vulkan|vulkan)\b/i.test(text);
}

function hasPositiveMetalEvidence(text: string): boolean {
	return /\b(sd_metal|ggml_metal|metal)\b/i.test(text);
}

function parseVersionLine(stdout: string, stderr: string): string | null {
	const text = (stdout || stderr || "").trim();
	if (!text) return null;
	const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0);
	return firstLine?.trim() ?? null;
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
		const proc = defaultSpawn(opts.spawnImpl)(binary, args, {
			signal: opts.signal,
		});
		const stderr = proc.stderr;
		// stable-diffusion.cpp prints `step: N/M` lines to stderr at each
		// denoise iteration. Tail the stream and forward as progress chunks
		// when the caller asked for them. Tolerate non-stream stderr (the
		// test spawn may pass null) — progress is best-effort.
		if (
			opts.onProgressChunk &&
			stderr &&
			typeof (stderr as NodeJS.ReadableStream).on === "function"
		) {
			let leftover = "";
			(stderr as NodeJS.ReadableStream).on("data", (chunk: Buffer | string) => {
				const text =
					leftover +
					(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
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

export function buildArgs(input: {
	modelPath: string;
	splitDiffusionModel?: boolean;
	vae?: string;
	llm?: string;
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
		input.splitDiffusionModel ? "--diffusion-model" : "--model",
		input.modelPath,
		"--prompt",
		input.prompt,
		"--width",
		String(input.width),
		"--height",
		String(input.height),
		"--steps",
		String(input.steps),
		"--cfg-scale",
		String(input.guidanceScale),
		"--seed",
		String(input.seed),
		"-o",
		input.output,
	];
	if (input.vae) {
		args.push("--vae", input.vae);
	}
	if (input.llm) {
		args.push("--llm", input.llm);
	}
	if (input.negativePrompt) {
		args.push("--negative-prompt", input.negativePrompt);
	}
	if (input.scheduler) {
		args.push("--sampling-method", input.scheduler);
	}
	if (input.accelerator === "vulkan") {
		args.push("--backend", "vulkan0");
	} else if (input.accelerator === "cpu") {
		args.push("--backend", "cpu", "--params-backend", "cpu");
	}
	// `auto` / `cuda` / `metal` rely on the binary build's defaults.
	return args;
}

/** 31-bit positive integer — sd-cpp stores seed as int32. */
export function pickSeed(): number {
	return Math.floor(Math.random() * 0x7fffffff);
}

/** Resolve a caller-supplied seed or pick a random one. */
export function resolveSeed(seed: number | undefined): number {
	return typeof seed === "number" && seed >= 0 ? seed : pickSeed();
}

export const PNG_SIGNATURE = [
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
] as const;

/**
 * Assert `bytes` begins with the PNG magic number. `label` is the
 * `[imagegen/<backend>]` prefix used in the error message.
 */
export function assertPngOutput(
	bytes: Uint8Array,
	label: string,
	errorCode: ConstructorParameters<typeof ImageGenBackendUnavailableError>[1],
): void {
	if (bytes.length < PNG_SIGNATURE.length) {
		throw new ImageGenBackendUnavailableError(
			label,
			errorCode,
			`[imagegen/${label}] output too short (${bytes.length} bytes); not a PNG`,
		);
	}
	for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
		if (bytes[i] !== PNG_SIGNATURE[i]) {
			throw new ImageGenBackendUnavailableError(
				label,
				errorCode,
				`[imagegen/${label}] output missing PNG signature`,
			);
		}
	}
}

/**
 * Wrap Node's `spawn` in the narrower `SdCppSpawnLike` shape that the
 * subprocess backends share. The cast is centralised here so call sites
 * don't each need their own `as unknown as` escape.
 */
export function defaultSpawn(
	spawnImpl: SdCppSpawnLike | undefined,
): SdCppSpawnLike {
	if (spawnImpl) return spawnImpl;
	const nodeSpawn: SdCppSpawnLike = (command, args, options) =>
		spawn(command, [...args], options);
	return nodeSpawn;
}
