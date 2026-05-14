/**
 * OpenVINO Whisper ASR decoder for the voice transcriber chain.
 *
 * Supplies a decoder function to `OpenVinoStreamingTranscriber` (which
 * implements the sliding-window + overlap streaming strategy). The decoder
 * spawns a persistent Python worker that loads `whisper-base.en` as an
 * OpenVINO IR and tries devices in order from `ELIZA_OPENVINO_WHISPER_DEVICE`
 * (default `NPU,CPU`). On Intel Lunar Lake NPU gives ~50× realtime + ~2 W;
 * CPU is the safe fallback (~28× realtime). GPU is *not* in the default
 * chain on Linux/Vulkan because OpenVINO/GPU + Vulkan llama-server on the
 * `xe` driver triggers iGPU GuC scheduler resets.
 *
 * This is the ASR half of the RFC at elizaOS/eliza#7633.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { StreamingPcmDecoder } from "./transcriber";

export const OPENVINO_WHISPER_DEFAULT_DEVICE_CHAIN = "NPU,CPU";

/**
 * Resolved runtime: the python interpreter that will run the worker, the
 * model IR directory, and the comma-separated device chain. Returns `null`
 * when any required piece is missing; the caller should fall through to
 * the next transcriber tier.
 */
export interface OpenVinoWhisperRuntime {
	pythonBin: string;
	workerScript: string;
	modelDir: string;
	deviceChain: string;
}

function firstExisting(
	candidates: ReadonlyArray<string | null | undefined>,
): string | null {
	for (const c of candidates) {
		if (c && existsSync(c)) return c;
	}
	return null;
}

/** Locate the python interpreter that has `openvino_genai` installed. */
function resolveOpenVinoPython(): string | null {
	const env = process.env.ELIZA_OPENVINO_PYTHON?.trim();
	if (env) return existsSync(env) ? env : null;
	return firstExisting([
		path.join(
			os.homedir(),
			".local",
			"voice-bench",
			"ov_venv",
			"bin",
			"python",
		),
		path.join(
			os.homedir(),
			".eliza",
			"local-inference",
			"openvino",
			"venv",
			"bin",
			"python",
		),
	]);
}

/** Locate the persistent Python worker script. */
function resolveWorkerScript(): string | null {
	const env = process.env.ELIZA_OPENVINO_WHISPER_WORKER?.trim();
	if (env) return existsSync(env) ? env : null;
	const here = path.dirname(new URL(import.meta.url).pathname);
	return firstExisting([
		path.resolve(
			here,
			"..",
			"..",
			"..",
			"..",
			"scripts",
			"openvino-whisper-asr-worker.py",
		),
		path.join(
			os.homedir(),
			".eliza",
			"local-inference",
			"openvino",
			"whisper-worker.py",
		),
	]);
}

/** Locate the whisper IR directory (a folder containing the OpenVINO XML+BIN). */
function resolveModelDir(): string | null {
	const env = process.env.ELIZA_OPENVINO_WHISPER_MODEL?.trim();
	if (env) return existsSync(env) ? env : null;
	return firstExisting([
		path.join(os.homedir(), ".local", "voice-bench", "whisper-base.en-int8-ov"),
		path.join(
			os.homedir(),
			".eliza",
			"local-inference",
			"openvino",
			"whisper-base.en-int8-ov",
		),
	]);
}

export function resolveOpenVinoWhisperRuntime(): OpenVinoWhisperRuntime | null {
	const pythonBin = resolveOpenVinoPython();
	if (!pythonBin) return null;
	const workerScript = resolveWorkerScript();
	if (!workerScript) return null;
	const modelDir = resolveModelDir();
	if (!modelDir) return null;
	const deviceChain =
		process.env.ELIZA_OPENVINO_WHISPER_DEVICE?.trim() ||
		OPENVINO_WHISPER_DEFAULT_DEVICE_CHAIN;
	return { pythonBin, workerScript, modelDir, deviceChain };
}

interface BunSpawnedProcess {
	readonly stdin: {
		write(chunk: Uint8Array): Promise<number> | number;
	};
	readonly stdout: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	kill(signal?: string | number): void;
}

interface BunNamespace {
	spawn(
		cmd: ReadonlyArray<string>,
		opts: Record<string, unknown>,
	): BunSpawnedProcess;
}

function bunOrThrow(): BunNamespace {
	const bun = (globalThis as { Bun?: BunNamespace }).Bun;
	if (!bun || typeof bun.spawn !== "function") {
		throw new Error(
			"[asr] OpenVINO whisper decoder requires the Bun runtime (Bun.spawn); production voice runs under Bun via Electrobun / Capacitor",
		);
	}
	return bun;
}

/**
 * Spawn the worker, return a decoder function bound to it. The worker
 * stays alive across `feed()` calls in `OpenVinoStreamingTranscriber`
 * so OpenVINO `WhisperPipeline.compile()` is paid exactly once (~350 ms on
 * CPU, ~3 s on GPU, ~3 s on NPU after warm).
 *
 * Protocol per request:
 *   stdin  ← u32 LE n_samples, then n_samples × f32 LE
 *   stdout → u32 LE n_bytes,   then n_bytes UTF-8 text
 *
 * The decoder serializes requests on a Promise chain so the caller can
 * issue concurrent decodes without interleaving on the pipe.
 */
export function makeOpenVinoWhisperDecoder(runtime: OpenVinoWhisperRuntime): {
	decoder: StreamingPcmDecoder;
	dispose: () => void;
} {
	const bun = bunOrThrow();
	const proc = bun.spawn([runtime.pythonBin, runtime.workerScript], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "inherit",
		env: {
			...process.env,
			ELIZA_OPENVINO_WHISPER_MODEL: runtime.modelDir,
			ELIZA_OPENVINO_WHISPER_DEVICE: runtime.deviceChain,
		},
	});

	const reader = proc.stdout.getReader();
	let stdoutBuf = new Uint8Array(0);

	async function readN(n: number): Promise<Uint8Array> {
		while (stdoutBuf.length < n) {
			const next = await reader.read();
			if (next.done) {
				throw new Error(
					"[asr] OpenVINO whisper worker stdout closed unexpectedly",
				);
			}
			const merged = new Uint8Array(stdoutBuf.length + next.value.length);
			merged.set(stdoutBuf, 0);
			merged.set(next.value, stdoutBuf.length);
			stdoutBuf = merged;
		}
		const head = stdoutBuf.subarray(0, n);
		stdoutBuf = stdoutBuf.subarray(n);
		return new Uint8Array(head);
	}

	// Chain serialization: each decode awaits the previous decode's pipe I/O
	// (stdin write + stdout read) so we never interleave on the worker. Critical
	// detail: `chain` itself MUST always resolve. If we did `chain = chain.then(work)`
	// and `work` rejected, every subsequent `chain.then(...)` would skip the
	// callback and propagate the rejection — silently breaking the rest of the
	// session. We keep the chain-state promise distinct from the caller's
	// promise so a single failure does not poison the queue.
	let chain: Promise<void> = Promise.resolve();
	let disposed = false;
	let dead = false;
	let deadReason: Error | null = null;

	// If the worker exits (openvino_genai missing, no viable device, model
	// corrupt, OOM kill...), mark the decoder dead so subsequent calls fail
	// immediately with a clear error rather than blocking forever on readN.
	proc.exited
		.then((code) => {
			if (!disposed) {
				dead = true;
				deadReason = new Error(
					`[asr] OpenVINO whisper worker exited unexpectedly (code=${code})`,
				);
			}
		})
		.catch(() => {
			/* ignore */
		});

	const decoder: StreamingPcmDecoder = (
		pcm16k: Float32Array,
	): Promise<string> => {
		if (disposed) {
			return Promise.reject(
				new Error("[asr] OpenVINO whisper decoder has been disposed"),
			);
		}
		if (dead) {
			return Promise.reject(
				deadReason ??
					new Error("[asr] OpenVINO whisper worker is no longer running"),
			);
		}
		const prev = chain;
		const work = (async (): Promise<string> => {
			await prev;
			if (dead) {
				throw deadReason ?? new Error("[asr] OpenVINO whisper worker died");
			}
			const header = new Uint8Array(4);
			new DataView(header.buffer).setUint32(0, pcm16k.length, true);
			const audioBytes = new Uint8Array(
				pcm16k.buffer,
				pcm16k.byteOffset,
				pcm16k.byteLength,
			);
			await proc.stdin.write(header);
			if (audioBytes.length > 0) {
				await proc.stdin.write(audioBytes);
			}
			const respHeader = await readN(4);
			const nBytes = new DataView(
				respHeader.buffer,
				respHeader.byteOffset,
				4,
			).getUint32(0, true);
			if (nBytes === 0) return "";
			const payload = await readN(nBytes);
			return new TextDecoder("utf-8").decode(payload);
		})();
		// `chain` must never reject — swallow the error here (the caller still
		// sees it via `work`). This keeps the queue traversable after failures.
		chain = work.then(
			() => undefined,
			() => undefined,
		);
		return work;
	};

	function dispose() {
		if (disposed) return;
		disposed = true;
		try {
			proc.kill();
		} catch {
			/* ignore */
		}
	}

	return { decoder, dispose };
}
