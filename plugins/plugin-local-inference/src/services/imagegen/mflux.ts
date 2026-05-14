/**
 * MLX-mflux image-gen backend (WS3) — macOS Apple Silicon.
 *
 * `mflux` is the community MLX port of FLUX.1 with Z-Image-Turbo support
 * (https://github.com/filipstrand/mflux). It's a Python package that
 * ships a `mflux-generate` CLI; we shell out to it from a venv the
 * bundle installer creates at `${MODELS_DIR}/mlx/mflux`.
 *
 * Why a venv (and not a Node MLX binding):
 *   - MLX Python is the canonical fast path on Apple Silicon — the
 *     mflux maintainers track upstream MLX optimizations directly.
 *   - There is no stable MLX Node binding today; writing one would
 *     duplicate MLX Python's surface for very little gain. Diffusion
 *     latency dominates the IPC cost.
 *   - The mflux CLI is stable, with `--model …`, `--prompt …`,
 *     `--steps …`, `--seed …`, `--output …`.
 *
 * Venv resolution:
 *   1. `opts.binaryPath` (test injection).
 *   2. `process.env.MFLUX_BIN` (operator override; usually the venv's
 *      `bin/mflux-generate`).
 *   3. `${MODELS_DIR}/mlx/mflux/bin/mflux-generate`.
 *
 * Model resolution:
 *   mflux expects `--model` to be either a HuggingFace repo id
 *   (`black-forest-labs/FLUX.1-schnell`) or a local checkpoint
 *   directory. The bundle installer writes the local path; we pass it
 *   verbatim.
 *
 * GPU validation status:
 *   On Apple Silicon this hits the Metal Performance Shaders backend
 *   through MLX. We have no Mac on this host — see
 *   `__tests__/imagegen-handler.test.ts` notes for the on-device check
 *   (M2 / M3 Max smoke for Z-Image-Turbo 4-step <2s 1024×1024).
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
import type { SdCppSpawnLike } from "./sd-cpp";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export interface MfluxBackendOptions {
	loadArgs: ImageGenLoadArgs;
	modelKey: string;
	binaryPath?: string;
	outputDir?: string;
	spawnImpl?: SdCppSpawnLike;
	/** Test seam — when set, skips subprocess and writes these bytes. */
	fakeImageBytes?: Uint8Array;
	now?: () => number;
}

const DEFAULT_BIN = "mflux-generate";

export async function loadMfluxImageGenBackend(
	opts: MfluxBackendOptions,
): Promise<ImageGenBackend> {
	const binary = resolveBinary(opts.binaryPath);
	const now = opts.now ?? Date.now;

	if (!opts.fakeImageBytes) {
		await assertBinaryAvailable(binary, opts.spawnImpl);
	}

	const outputDir = opts.outputDir ?? mkdtempSync(join(tmpdir(), "mflux-"));
	let disposed = false;

	return {
		id: "mflux",
		supports(req) {
			// mflux supports flexible WxH but resolution must be a /16 multiple
			// for FLUX. SD 1.5 in mflux (less common) needs /8. We round up,
			// so accept anything reasonable.
			const w = req.width ?? 1024;
			const h = req.height ?? 1024;
			if (w <= 0 || h <= 0) return false;
			if (w > 2048 || h > 2048) return false;
			return true;
		},
		async generate(req): Promise<ImageGenResult> {
			if (disposed) {
				throw new ImageGenBackendUnavailableError(
					"mflux",
					"subprocess_failed",
					"[imagegen/mflux] generate called after dispose()",
				);
			}
			if (!req.prompt || !req.prompt.trim()) {
				throw new ImageGenBackendUnavailableError(
					"mflux",
					"unsupported_request",
					"[imagegen/mflux] prompt is empty",
				);
			}
			const seed = typeof req.seed === "number" && req.seed >= 0
				? req.seed
				: Math.floor(Math.random() * 0x7fffffff);
			const width = req.width ?? 1024;
			const height = req.height ?? 1024;
			// FLUX schnell / Z-Image-Turbo are 4-step turbo models; default
			// to 4 here when the caller didn't specify.
			const steps = req.steps ?? 4;
			// FLUX schnell is CFG-free; mflux ignores the value but we record
			// it as 0 in metadata when the caller didn't ask for one.
			const guidanceScale = req.guidanceScale ?? 0;
			const outputPath = join(outputDir, `out-${seed}-${now()}.png`);
			const startMs = now();

			if (opts.fakeImageBytes) {
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

			if (!existsSync(opts.loadArgs.modelPath)) {
				throw new ImageGenBackendUnavailableError(
					"mflux",
					"model_missing",
					`[imagegen/mflux] model not found: ${opts.loadArgs.modelPath}`,
				);
			}

			const args: string[] = [
				"--model", opts.loadArgs.modelPath,
				"--prompt", req.prompt,
				"--width", String(width),
				"--height", String(height),
				"--steps", String(steps),
				"--seed", String(seed),
				"--output", outputPath,
			];
			if (req.guidanceScale !== undefined) {
				args.push("--guidance", String(req.guidanceScale));
			}

			await runMflux(binary, args, {
				signal: req.signal,
				spawnImpl: opts.spawnImpl,
				onProgressChunk: req.onProgressChunk,
				totalSteps: steps,
			});

			const bytes = new Uint8Array(await fs.readFile(outputPath));
			assertPng(bytes);
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
	const envBin = process.env.MFLUX_BIN;
	if (envBin && envBin.trim()) return envBin.trim();
	return DEFAULT_BIN;
}

async function assertBinaryAvailable(
	binary: string,
	spawnImpl?: SdCppSpawnLike,
): Promise<void> {
	try {
		const code = await new Promise<number | null>((resolve, reject) => {
			const proc = (spawnImpl ?? (spawn as unknown as SdCppSpawnLike))(
				binary,
				["--help"],
			);
			proc.on("error", (err: Error) => reject(err));
			proc.on("exit", (c: number | null) => resolve(c));
		});
		// `mflux-generate --help` exits 0 on success. Tolerate code 2 in
		// older mflux versions where --help is the default and exits non-zero.
		if (code !== 0 && code !== 2) {
			throw new ImageGenBackendUnavailableError(
				"mflux",
				"binary_version_mismatch",
				`[imagegen/mflux] '${binary} --help' exited with code ${code}`,
			);
		}
	} catch (err) {
		if (err instanceof ImageGenBackendUnavailableError) throw err;
		const message = err instanceof Error ? err.message : String(err);
		throw new ImageGenBackendUnavailableError(
			"mflux",
			"binary_missing",
			`[imagegen/mflux] cannot run '${binary} --help': ${message}. Set MFLUX_BIN or install the bundle's mflux venv at \${MODELS_DIR}/mlx/mflux.`,
			{ cause: err },
		);
	}
}

async function runMflux(
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
		if (opts.onProgressChunk && stderr && typeof (stderr as NodeJS.ReadableStream).on === "function") {
			let leftover = "";
			(stderr as NodeJS.ReadableStream).on("data", (chunk: Buffer | string) => {
				const text = leftover + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
				const lines = text.split(/\r?\n/);
				leftover = lines.pop() ?? "";
				for (const line of lines) {
					// mflux prints `Step N/M` to stderr (tqdm-style).
					const m = line.match(/step\s*(\d+)\s*\/\s*(\d+)/i);
					if (!m) continue;
					opts.onProgressChunk?.({
						step: Number(m[1]),
						total: Number(m[2]) || opts.totalSteps,
					});
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
					"mflux",
					"subprocess_failed",
					`[imagegen/mflux] mflux-generate exited with code ${code}`,
				),
			);
		});
	});
}

function assertPng(bytes: Uint8Array): void {
	if (bytes.length < PNG_SIGNATURE.length) {
		throw new ImageGenBackendUnavailableError(
			"mflux",
			"subprocess_failed",
			`[imagegen/mflux] output too short (${bytes.length} bytes); not a PNG`,
		);
	}
	for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
		if (bytes[i] !== PNG_SIGNATURE[i]) {
			throw new ImageGenBackendUnavailableError(
				"mflux",
				"subprocess_failed",
				"[imagegen/mflux] output missing PNG signature",
			);
		}
	}
}
