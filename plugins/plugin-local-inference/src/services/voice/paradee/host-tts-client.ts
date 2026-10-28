/**
 * Client for the explicit host Paradee worker (`src/host-tts-worker.ts`).
 *
 * The worker speaks newline-delimited JSON: requests on stdin, results on
 * fd 3, stdout/stderr ignored. It runs one request at a time and answers a
 * second concurrent request with `busy`, so this client queues requests and
 * sends the next only after the previous one has been answered. Cancelling the
 * request in flight sends `{op:"cancel"}`; the worker repeats the native
 * `eliza_inference_cancel_tts` until the engine answers, and a worker that does
 * not answer within `cancelGraceMs` is killed (the next request respawns it).
 *
 * The packaged app keeps its own copy of this protocol client
 * (`packages/app/src/api/standalone-speech-service.ts`) for the explicit
 * `/api/tts/paradee` route; this one serves the agent voice pipeline.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ParadeeEngineConfig } from "./paradee-engine-discovery";

/** Largest WAV the worker returns: 60 s of mono PCM16 at 24 kHz. */
const MAX_WAV_BYTES = 44 + 60 * 24_000 * 2;
const MAX_LINE_CHARS = Math.ceil(MAX_WAV_BYTES / 3) * 4 + 1024;
/** The worker refuses longer text (`host-tts-worker.ts` parse()). */
export const PARADEE_WORKER_MAX_TEXT_CHARS = 500;

export class ParadeeSpeechCancelledError extends Error {
	constructor() {
		super("[paradee] speech cancelled");
		this.name = "ParadeeSpeechCancelledError";
	}
}

export interface HostTtsClientOptions {
	config: ParadeeEngineConfig;
	/** Worker module; defaults to the package's `./host-tts-worker` export. */
	workerPath?: string;
	/** Executable that runs the worker; defaults to this Bun, else `bun`. */
	bunPath?: string;
	/** Upper bound for one synthesis before it is cancelled. */
	deadlineMs?: number;
	/** How long a cancelled request may take before the worker is killed. */
	cancelGraceMs?: number;
	/** Process spawner seam for tests. */
	spawnImpl?: typeof spawn;
}

interface Pending {
	id: string;
	resolve: (wav: Buffer) => void;
	reject: (error: Error) => void;
	cancelled: boolean;
	grace?: ReturnType<typeof setTimeout>;
}

/** Bun arguments for the worker; source checkouts need the source condition. */
export function hostTtsWorkerArgs(workerPath: string): string[] {
	return [
		"--no-install",
		...(workerPath.endsWith(".ts") ? ["--conditions=eliza-source"] : []),
		workerPath,
	];
}

function defaultWorkerPath(): string {
	return fileURLToPath(
		import.meta.resolve("@elizaos/plugin-local-inference/host-tts-worker"),
	);
}

/** Decode the worker's base64 WAV, rejecting anything that is not one. */
export function decodeWorkerWav(audio: unknown): Buffer {
	if (typeof audio !== "string" || audio.length > MAX_LINE_CHARS) {
		throw new Error("[paradee] invalid speech output");
	}
	const wav = Buffer.from(audio, "base64");
	if (
		wav.length < 44 ||
		wav.length > MAX_WAV_BYTES ||
		wav.toString("ascii", 0, 4) !== "RIFF" ||
		wav.toString("ascii", 8, 12) !== "WAVE"
	) {
		throw new Error("[paradee] invalid speech WAV");
	}
	return wav;
}

export class HostTtsClient {
	private readonly opts: HostTtsClientOptions;
	private child: ChildProcess | null = null;
	private boot: Promise<void> | null = null;
	private pending: Pending | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private disposed = false;

	constructor(opts: HostTtsClientOptions) {
		this.opts = opts;
	}

	get running(): boolean {
		return this.child !== null;
	}

	/** Start the worker and wait for its readiness line (warm-up synthesis). */
	initialize(): Promise<void> {
		if (this.disposed)
			return Promise.reject(new Error("[paradee] client disposed"));
		if (this.boot) return this.boot;
		const boot = this.spawnWorker();
		this.boot = boot;
		boot.catch(() => {
			if (this.boot === boot) this.boot = null;
		});
		return boot;
	}

	/**
	 * Synthesize `text` (at most `PARADEE_WORKER_MAX_TEXT_CHARS`) to a mono
	 * PCM16 WAV. `isCancelled` is polled while the request waits or runs;
	 * once it reports true the request is cancelled natively and the promise
	 * rejects with `ParadeeSpeechCancelledError`.
	 */
	synthesize(text: string, isCancelled: () => boolean): Promise<Buffer> {
		const run = this.queue.then(
			() => this.runOne(text, isCancelled),
			() => this.runOne(text, isCancelled),
		);
		this.queue = run.catch(() => undefined);
		return run;
	}

	/** Release native memory after admitted requests finish; the next use reloads. */
	unload(): Promise<void> {
		const release = async () => {
			// A separate warm-up may still be starting. Kill it too; waiting
			// for readiness would prevent reclaiming a stalled startup.
			const child = this.child;
			if (!child) return;
			await new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					child.removeListener("exit", exited);
					child.removeListener("error", failed);
				};
				const exited = () => {
					cleanup();
					resolve();
				};
				const failed = (error: Error) => {
					cleanup();
					reject(error);
				};
				child.once("exit", exited);
				child.once("error", failed);
				if (!this.stop(new Error("[paradee] speech worker unloaded"))) {
					failed(new Error("[paradee] could not stop speech worker"));
				} else if (child.exitCode !== null || child.signalCode !== null) {
					exited();
				}
			});
		};
		const unloaded = this.queue.then(release, release);
		this.queue = unloaded.catch(() => undefined);
		return unloaded;
	}

	/** Kill the worker; queued and in-flight requests reject. */
	dispose(): void {
		this.disposed = true;
		this.stop(new Error("[paradee] speech worker stopped"));
	}

	private async runOne(
		text: string,
		isCancelled: () => boolean,
	): Promise<Buffer> {
		if (isCancelled()) throw new ParadeeSpeechCancelledError();
		await this.initialize();
		if (isCancelled()) throw new ParadeeSpeechCancelledError();
		const child = this.child;
		const input = child?.stdin;
		if (!child || !input) throw new Error("[paradee] speech worker exited");
		const id = randomUUID();
		return new Promise<Buffer>((resolve, reject) => {
			const deadlineMs = this.opts.deadlineMs ?? 60_000;
			const startedAt = Date.now();
			const settle = () => {
				clearInterval(poll);
				clearTimeout(pending.grace);
			};
			const pending: Pending = {
				id,
				cancelled: false,
				resolve: (wav) => {
					settle();
					resolve(wav);
				},
				reject: (error) => {
					settle();
					reject(error);
				},
			};
			const cancel = () => {
				if (pending.cancelled || this.pending !== pending) return;
				pending.cancelled = true;
				input.write(`${JSON.stringify({ id, op: "cancel" })}\n`);
				pending.grace = setTimeout(() => {
					if (this.pending === pending)
						this.stop(new ParadeeSpeechCancelledError());
				}, this.opts.cancelGraceMs ?? 10_000);
				pending.grace.unref?.();
			};
			const poll = setInterval(() => {
				if (isCancelled() || Date.now() - startedAt > deadlineMs) cancel();
			}, 10);
			poll.unref?.();
			this.pending = pending;
			input.write(`${JSON.stringify({ id, op: "synthesize", text })}\n`);
		});
	}

	private spawnWorker(): Promise<void> {
		const { config } = this.opts;
		const env: NodeJS.ProcessEnv = {
			ELIZA_INFERENCE_LIBRARY: config.library,
			ELIZA_INFERENCE_LIBRARY_SHA256: config.librarySha256,
			ELIZA_PARADEE_MODEL_DIR: config.modelDir,
		};
		for (const key of ["PATH", "HOME", "TMPDIR", "LANG"]) {
			const value = process.env[key];
			if (value) env[key] = value;
		}
		const bun =
			this.opts.bunPath ?? (process.versions.bun ? process.execPath : "bun");
		const child = (this.opts.spawnImpl ?? spawn)(
			bun,
			hostTtsWorkerArgs(this.opts.workerPath ?? defaultWorkerPath()),
			{ env, stdio: ["pipe", "ignore", "ignore", "pipe"] },
		);
		this.child = child;
		return new Promise<void>((resolve, reject) => {
			let ready = false;
			let text = "";
			const failed = () => {
				const error = new Error(
					ready
						? "[paradee] speech worker exited"
						: "[paradee] speech worker failed to start (library or model refused, or unsupported ABI)",
				);
				if (this.child === child) this.stop(error);
				if (!ready) reject(error);
			};
			child.once("error", failed);
			child.once("exit", failed);
			child.stdin?.on("error", failed);
			const output = child.stdio[3] as Readable | null | undefined;
			if (!output) {
				failed();
				return;
			}
			output.on("error", failed);
			output.once("close", failed);
			output.on("data", (bytes: Buffer) => {
				if (this.child !== child) return;
				text += bytes.toString("utf8");
				if (text.length > MAX_LINE_CHARS) {
					failed();
					return;
				}
				for (
					let newline = text.indexOf("\n");
					newline >= 0;
					newline = text.indexOf("\n")
				) {
					const line = text.slice(0, newline);
					text = text.slice(newline + 1);
					let value: Record<string, unknown>;
					try {
						value = JSON.parse(line) as Record<string, unknown>;
					} catch {
						failed();
						return;
					}
					if (!ready) {
						if (value.ready !== true) {
							failed();
							return;
						}
						ready = true;
						resolve();
						continue;
					}
					const pending = this.pending;
					if (!pending || value.id !== pending.id) {
						failed();
						return;
					}
					this.pending = null;
					if (typeof value.error === "string") {
						pending.reject(
							pending.cancelled || value.error === "cancelled"
								? new ParadeeSpeechCancelledError()
								: new Error(`[paradee] speech synthesis ${value.error}`),
						);
						continue;
					}
					try {
						const wav = decodeWorkerWav(value.audio);
						if (pending.cancelled) {
							pending.reject(new ParadeeSpeechCancelledError());
						} else {
							pending.resolve(wav);
						}
					} catch (error) {
						pending.reject(error as Error);
					}
				}
			});
		});
	}

	private stop(error: Error): boolean {
		const child = this.child;
		const stopped =
			!child ||
			child.exitCode !== null ||
			child.signalCode !== null ||
			child.kill("SIGKILL");
		if (stopped) {
			this.child = null;
			this.boot = null;
		}
		const pending = this.pending;
		this.pending = null;
		pending?.reject(error);
		return stopped;
	}
}
