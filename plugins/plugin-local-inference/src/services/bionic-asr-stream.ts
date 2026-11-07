/**
 * Client half of the bionic host's streaming ASR ops (Phonon-2 / parakeet
 * backend in libelizainference, ABI 18). The Java half is
 * `BionicAsrStreams` behind `ElizaBionicInferenceServer`.
 *
 * One stream holds one UDS connection open. Requests on it are strictly
 * sequential (`[int32 BE length][UTF-8 JSON]` each way, one response per
 * request):
 *
 *   asr_stream_open    {bundleDir, sampleRate} -> {ok, streamId} | {ok:false, code:"STREAM_UNSUPPORTED"}
 *   asr_stream_feed    {pcmBase64}             -> {ok, samples, totalSamples}
 *   asr_stream_partial {}                      -> {ok, text}
 *   asr_stream_finish  {}                      -> {ok, text}
 *   asr_stream_close   {}                      -> {ok}
 *
 * `asr_stream_cancel {streamId}` goes on a second connection so it reaches
 * the host while a partial/finish decodes on the first. Closing the socket
 * also cancels and frees the stream on the host.
 */

import net from "node:net";

/** Host bound on one asr_stream_feed (BionicAsrStreams.MAX_FEED_SECONDS). */
export const BIONIC_ASR_STREAM_MAX_FEED_SECONDS = 5;
/** Host bound on a whole stream (BionicAsrStreams.MAX_STREAM_SECONDS). */
export const BIONIC_ASR_STREAM_MAX_SECONDS = 120;
/** Largest response frame a stream op may return (transcripts are short). */
const MAX_STREAM_RESPONSE_BYTES = 256 * 1024;
/** Per-request budget; a cold first partial loads the ASR weights. */
const STREAM_REQUEST_TIMEOUT_MS = 60_000;

export interface BionicAsrStreamResponse {
	ok: boolean;
	error?: string;
	code?: string;
	text?: string;
	streamId?: string;
	samples?: number;
	totalSamples?: number;
	supported?: boolean;
	signalled?: boolean;
	ms?: number;
}

/** Thrown when an op fails on the host; `code` carries the host's code. */
export class BionicAsrStreamError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "BionicAsrStreamError";
	}
}

/** Resolve the loader's socket name to a node:net path (abstract namespace on Android). */
export function bionicSocketPath(socketName: string): string {
	// A filesystem path (host tests, desktop harnesses) is used as is; a bare
	// name is the Android abstract-namespace socket.
	return socketName.startsWith("/") ? socketName : `\0${socketName}`;
}

export function encodeFrame(request: Record<string, unknown>): Buffer {
	const payload = Buffer.from(JSON.stringify(request), "utf8");
	const frame = Buffer.allocUnsafe(4 + payload.length);
	frame.writeUInt32BE(payload.length, 0);
	payload.copy(frame, 4);
	return frame;
}

export function pcmToBase64LE(pcm: Float32Array): string {
	const buf = Buffer.allocUnsafe(pcm.length * 4);
	for (let i = 0; i < pcm.length; i++) buf.writeFloatLE(pcm[i] ?? 0, i * 4);
	return buf.toString("base64");
}

interface Pending {
	resolve: (value: BionicAsrStreamResponse) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Persistent request/response connection for one ASR stream. Requests are
 * written immediately and answered in order (the host handles one frame at a
 * time per connection), so a FIFO of pending replies is the whole protocol.
 */
export class BionicAsrStreamConnection {
	private readonly sock: net.Socket;
	private readonly connected: Promise<void>;
	private readonly pending: Pending[] = [];
	private buf: Buffer = Buffer.alloc(0);
	private failure: Error | null = null;

	constructor(socketPath: string) {
		this.sock = net.connect({ path: socketPath });
		this.connected = new Promise<void>((resolve, reject) => {
			this.sock.once("connect", () => resolve());
			this.sock.once("error", (e) => reject(e));
		});
		// The connect promise may never be awaited after a failure.
		this.connected.catch(() => undefined);
		this.sock.on("data", (d: Buffer) => this.onData(d));
		this.sock.on("error", (e: Error) =>
			this.fail(new BionicAsrStreamError(`socket error: ${e.message}`)),
		);
		this.sock.on("close", () =>
			this.fail(new BionicAsrStreamError("host closed the stream connection")),
		);
	}

	async request(
		req: Record<string, unknown>,
	): Promise<BionicAsrStreamResponse> {
		if (this.failure) throw this.failure;
		await this.connected;
		if (this.failure) throw this.failure;
		return new Promise<BionicAsrStreamResponse>((resolve, reject) => {
			const timer = setTimeout(
				() =>
					this.fail(
						new BionicAsrStreamError(`${String(req.op)} timed out`, "TIMEOUT"),
					),
				STREAM_REQUEST_TIMEOUT_MS,
			);
			this.pending.push({ resolve, reject, timer });
			this.sock.write(encodeFrame(req));
		});
	}

	/** Drop the connection; the host cancels and frees the stream. */
	destroy(): void {
		this.fail(new BionicAsrStreamError("stream connection closed", "CLOSED"));
	}

	private onData(d: Buffer): void {
		this.buf = this.buf.length === 0 ? d : Buffer.concat([this.buf, d]);
		for (;;) {
			if (this.buf.length < 4) return;
			const n = this.buf.readUInt32BE(0);
			if (n > MAX_STREAM_RESPONSE_BYTES) {
				this.fail(new BionicAsrStreamError(`bad stream frame length ${n}`));
				return;
			}
			if (this.buf.length < 4 + n) return;
			const json = this.buf.subarray(4, 4 + n).toString("utf8");
			this.buf = this.buf.subarray(4 + n);
			const next = this.pending.shift();
			if (!next) {
				this.fail(new BionicAsrStreamError("unsolicited stream frame"));
				return;
			}
			clearTimeout(next.timer);
			try {
				next.resolve(JSON.parse(json) as BionicAsrStreamResponse);
			} catch (e) {
				next.reject(
					new BionicAsrStreamError(
						`malformed stream frame: ${e instanceof Error ? e.message : String(e)}`,
					),
				);
			}
		}
	}

	private fail(err: Error): void {
		if (!this.failure) this.failure = err;
		for (const p of this.pending.splice(0)) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.sock.destroy();
	}
}

/** One-shot request on a fresh connection (supported probe, cancel). */
export async function bionicAsrOneShot(
	socketPath: string,
	req: Record<string, unknown>,
): Promise<BionicAsrStreamResponse> {
	const conn = new BionicAsrStreamConnection(socketPath);
	try {
		return await conn.request(req);
	} finally {
		conn.destroy();
	}
}

/**
 * An open streaming ASR session on the bionic host. Callers serialize their
 * own calls (the transcriber does); `cancel()` may be called at any time.
 */
export class BionicAsrStream {
	private closed = false;
	private finished = false;

	constructor(
		private readonly conn: BionicAsrStreamConnection,
		private readonly socketPath: string,
		readonly streamId: string,
		readonly sampleRate: number,
	) {}

	/** Buffer mono fp32 PCM at `sampleRate` on the host (no decode). */
	async feed(pcm: Float32Array): Promise<number> {
		const maxSamples = BIONIC_ASR_STREAM_MAX_FEED_SECONDS * this.sampleRate;
		let consumed = 0;
		for (let off = 0; off < pcm.length; off += maxSamples) {
			const res = await this.op({
				op: "asr_stream_feed",
				pcmBase64: pcmToBase64LE(pcm.subarray(off, off + maxSamples)),
			});
			consumed += typeof res.samples === "number" ? res.samples : 0;
		}
		return consumed;
	}

	/** Decode what was fed and return the running transcript. */
	async partial(): Promise<string> {
		return (await this.op({ op: "asr_stream_partial" })).text ?? "";
	}

	/** Drain, decode with full right context and return the final transcript. */
	async finish(): Promise<string> {
		const text = (await this.op({ op: "asr_stream_finish" })).text ?? "";
		this.finished = true;
		return text;
	}

	get isFinished(): boolean {
		return this.finished;
	}

	/** Stop a running partial/finish (it answers CANCELLED). Never throws. */
	async cancel(): Promise<boolean> {
		if (this.closed) return false;
		try {
			const res = await bionicAsrOneShot(this.socketPath, {
				op: "asr_stream_cancel",
				streamId: this.streamId,
			});
			return res.ok && res.signalled === true;
		} catch {
			// error-policy:J3 the stream connection close below also cancels.
			return false;
		}
	}

	/** Free the host stream and the connection. Idempotent. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			await this.conn.request({ op: "asr_stream_close" });
		} catch {
			// error-policy:J3 dropping the connection frees the stream on the host.
		} finally {
			this.conn.destroy();
		}
	}

	private async op(
		req: Record<string, unknown>,
	): Promise<BionicAsrStreamResponse> {
		if (this.closed) {
			throw new BionicAsrStreamError(
				`${String(req.op)} on a closed stream`,
				"CLOSED",
			);
		}
		const res = await this.conn.request(req);
		if (!res.ok) {
			throw new BionicAsrStreamError(
				res.error ?? `${String(req.op)} failed`,
				res.code,
			);
		}
		return res;
	}
}

/**
 * Open a stream. Resolves `null` when the host's ASR backend cannot stream
 * (`STREAM_UNSUPPORTED`, a host library built without the Parakeet-TDT
 * backend), which is the only case a caller should fall back to batch
 * `op:"asr"`. Other failures reject.
 */
export async function openBionicAsrStream(args: {
	socketPath: string;
	bundleDir: string;
	sampleRate: number;
}): Promise<BionicAsrStream | null> {
	const conn = new BionicAsrStreamConnection(args.socketPath);
	let res: BionicAsrStreamResponse;
	try {
		res = await conn.request({
			op: "asr_stream_open",
			bundleDir: args.bundleDir,
			sampleRate: args.sampleRate,
		});
	} catch (err) {
		conn.destroy();
		throw err;
	}
	if (
		!res.ok ||
		typeof res.streamId !== "string" ||
		res.streamId.length === 0
	) {
		conn.destroy();
		if (res.code === "STREAM_UNSUPPORTED") return null;
		throw new BionicAsrStreamError(
			res.error ?? "asr_stream_open failed",
			res.code,
		);
	}
	return new BionicAsrStream(
		conn,
		args.socketPath,
		res.streamId,
		args.sampleRate,
	);
}
