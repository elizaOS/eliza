/**
 * Shared process runtime for the explicit host-only speech workers
 * (`host-tts-worker`, `host-asr-worker`).
 *
 * The protocol thread owns fd 3 (results) and stdin (requests). Native calls
 * block, so they run on an engine thread: a `worker_threads` Worker that
 * re-enters the same worker module. Keeping the protocol thread free lets a
 * `{op:"cancel"}` request reach the native cancel entry point while the engine
 * thread is inside a forward pass. Diagnostics never reach callers: the
 * service discards stderr, and failures are reported as fixed error codes.
 */
import { createHash } from "node:crypto";
import {
	closeSync,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	writeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { parentPort, Worker } from "node:worker_threads";
import type { ElizaInferenceContextHandle } from "./services/voice/ffi-bindings";

/** One pinned file the worker hashes before any native code loads. */
export interface PinnedSpeechAsset {
	/** Path relative to the asset root. */
	path: string;
	sha256: string;
	bytes: number;
}

const emit = (value: unknown) => writeSync(3, `${JSON.stringify(value)}\n`);

/** SHA-256 of a regular, non-link file of at most `maximum` bytes. */
export function sha256File(path: string, maximum: number): string {
	if (!isAbsolute(path) || !lstatSync(path).isFile())
		throw Error("Invalid speech asset");
	const fd = openSync(path, "r");
	try {
		const { size } = fstatSync(fd);
		if (size > maximum) throw Error("Invalid speech asset");
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
		for (let read = 0; read < size; ) {
			const n = readSync(fd, buffer, 0, buffer.length, read);
			if (n <= 0) throw Error("Invalid speech asset");
			hash.update(buffer.subarray(0, n));
			read += n;
		}
		return hash.digest("hex");
	} finally {
		closeSync(fd);
	}
}

/** Hash the library named by ELIZA_INFERENCE_LIBRARY against its reviewed digest. */
export function verifiedInferenceLibrary(): string {
	const library = process.env.ELIZA_INFERENCE_LIBRARY || "";
	if (
		!/^[a-f0-9]{64}$/.test(process.env.ELIZA_INFERENCE_LIBRARY_SHA256 ?? "") ||
		sha256File(library, 256 * 1024 * 1024) !==
			process.env.ELIZA_INFERENCE_LIBRARY_SHA256
	)
		throw Error("Unverified speech library");
	return library;
}

/** Hash every pinned asset under `root`; any mismatch refuses the worker. */
export function verifyPinnedAssets(
	root: string,
	assets: readonly PinnedSpeechAsset[],
): void {
	if (!isAbsolute(root)) throw Error("Invalid speech asset root");
	for (const asset of assets) {
		const file = join(root, asset.path);
		if (
			lstatSync(file).size !== asset.bytes ||
			sha256File(file, asset.bytes) !== asset.sha256
		)
			throw Error("Unverified speech model");
	}
}

/** What the engine thread sets up once, on its own thread. */
export interface SpeechEngine<Request> {
	ctx: ElizaInferenceContextHandle;
	/** Run one request. Throws on failure, including a cancelled call. */
	run(request: Request): Record<string, unknown>;
	/** Free the region the requests use (`mmap_evict`); `run` reloads it. */
	release(): void;
	dispose(): void;
}

type EngineMessage =
	| { type: "ready"; ctx: ElizaInferenceContextHandle }
	| { type: "result"; id: string; value: Record<string, unknown> }
	| { type: "error"; id: string };

/** Engine-thread side: build the engine, then run requests in order. */
export function serveSpeechEngine<Request extends { id: string }>(
	create: () => SpeechEngine<Request>,
): void {
	const port = parentPort;
	if (!port) throw Error("Speech engine requires a worker thread");
	const engine = create();
	port.on(
		"message",
		(message: { type: "run"; request: Request } | { type: "release" }) => {
			if (message.type === "release") {
				engine.release();
				return;
			}
			const { request } = message;
			try {
				port.postMessage({
					type: "result",
					id: request.id,
					value: engine.run(request),
				} satisfies EngineMessage);
			} catch {
				port.postMessage({
					type: "error",
					id: request.id,
				} satisfies EngineMessage);
			}
		},
	);
	port.once("close", () => engine.dispose());
	port.postMessage({ type: "ready", ctx: engine.ctx } satisfies EngineMessage);
}

/** Protocol-thread side of a host speech worker. */
export interface SpeechProtocol<Request extends { id: string }> {
	/** The worker module to start as the engine thread (its `import.meta.url`). */
	engineUrl: URL;
	/** Maximum request line length in UTF-16 code units. */
	maxLine: number;
	/** Validate one parsed request; throw to refuse it. */
	parse(input: Record<string, unknown>): Request;
	/** Native cancel for the call in flight on `ctx`, from this thread. */
	cancel(ctx: ElizaInferenceContextHandle): void;
	/** Release the engine's region after this long without a request. */
	idleReleaseMs: number;
}

const ID_PATTERN = /^[0-9a-f-]{36}$/i;

/**
 * Run the protocol thread until stdin closes. One request runs at a time.
 * `{op:"cancel", id}` cancels the request in flight with that id; the native
 * cancel is repeated until the engine answers, because each native call clears
 * its cancel flag when it starts and a single early cancel could be lost.
 */
export async function serveSpeechProtocol<Request extends { id: string }>(
	protocol: SpeechProtocol<Request>,
): Promise<void> {
	const engine = new Worker(protocol.engineUrl);
	let ctx: ElizaInferenceContextHandle | undefined;
	let inflight:
		| {
				id: string;
				cancelled: boolean;
				repeat?: ReturnType<typeof setInterval>;
		  }
		| undefined;
	let idle: ReturnType<typeof setTimeout> | undefined;
	let failure: ((error: Error) => void) | undefined;
	const failed = new Promise<never>((_, reject) => {
		failure = reject;
	});
	failed.catch(() => {});
	engine.once("error", () => failure?.(Error("Speech engine failed")));
	engine.once("exit", () => failure?.(Error("Speech engine exited")));
	const ready = new Promise<void>((resolve) => {
		engine.on("message", (message: EngineMessage) => {
			if (message.type === "ready") {
				ctx = message.ctx;
				resolve();
				return;
			}
			const current = inflight;
			if (!current || current.id !== message.id) return;
			clearInterval(current.repeat);
			inflight = undefined;
			if (current.cancelled) emit({ id: current.id, error: "cancelled" });
			else if (message.type === "error")
				emit({ id: current.id, error: "failed" });
			else emit({ ...message.value, id: current.id });
			clearTimeout(idle);
			idle = setTimeout(
				() => engine.postMessage({ type: "release" }),
				protocol.idleReleaseMs,
			);
			idle.unref?.();
		});
	});
	try {
		await Promise.race([ready, failed]);
		emit({ ready: true });
		const lines = createInterface({
			input: process.stdin,
			crlfDelay: Infinity,
		});
		const requests = (async () => {
			for await (const line of lines) {
				if (line.length > protocol.maxLine)
					throw Error("Oversized speech request");
				const input = JSON.parse(line) as Record<string, unknown>;
				if (
					!input ||
					typeof input !== "object" ||
					typeof input.id !== "string" ||
					!ID_PATTERN.test(input.id)
				)
					throw Error("Invalid speech request");
				if (input.op === "cancel") {
					const current = inflight;
					if (
						current?.id === input.id &&
						!current.cancelled &&
						ctx !== undefined
					) {
						const owned = ctx;
						current.cancelled = true;
						protocol.cancel(owned);
						current.repeat = setInterval(() => protocol.cancel(owned), 50);
					}
					continue;
				}
				const request = protocol.parse(input);
				if (inflight) {
					emit({ id: request.id, error: "busy" });
					continue;
				}
				clearTimeout(idle);
				inflight = { id: request.id, cancelled: false };
				engine.postMessage({ type: "run", request });
			}
		})();
		await Promise.race([requests, failed]);
	} finally {
		clearTimeout(idle);
		clearInterval(inflight?.repeat);
		await engine.terminate();
	}
}
