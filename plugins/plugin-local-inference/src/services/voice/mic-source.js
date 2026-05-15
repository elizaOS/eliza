/**
 * Mic capture → `PcmRingBuffer` + VAD tee.
 *
 * The `MicSource` interface (see `./types`) is the only seam the rest of the
 * voice loop sees. The first concrete implementation, `DesktopMicSource`,
 * shells out to the platform's standard PCM-capable recorder, emits 16 kHz
 * mono `PcmFrame`s, and lets callers tee them anywhere:
 *
 *   mic → DesktopMicSource ─┬─→ PcmRingBuffer  (ASR reads PCM from here)
 *                           └─→ VadDetector    (speech / barge-in signals)
 *
 * Per-platform recorder selection (in priority order):
 *   - Linux:   `arecord` (alsa-utils), else `parec` (PulseAudio), else `sox`/`rec`.
 *   - macOS:   `sox`/`rec` (`sox -d`), else `ffmpeg -f avfoundation`.
 *   - Windows: `ffmpeg -f dshow` (DirectShow capture — bundled with most
 *              Windows installs of ffmpeg; the renderer's `getUserMedia` path
 *              feeding `PushMicSource` is the no-ffmpeg route).
 *
 * Connectors that already have a decoded PCM stream (Discord voice, the
 * Electrobun renderer's `getUserMedia` path, a mobile capture callback —
 * the Capacitor `Microphone` plugin on iOS/Android) implement `MicSource`
 * over `PushMicSource` instead of spawning a process.
 *
 * No fallback sludge: if no recorder binary is on PATH (and no override
 * argv was given), `start()` throws — the caller surfaces "no mic backend
 * available", it does not pretend to capture silence.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { PcmRingBuffer } from "./ring-buffer";

/** Resolve an executable on PATH (with the Windows extension list). */
function whichBin(bin) {
	const pathEnv = process.env.PATH ?? "";
	const exts =
		process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	for (const dir of pathEnv.split(path.delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = path.join(dir, bin + ext);
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}
/**
 * Pick the recorder that streams raw signed 16-bit LE mono PCM at
 * `sampleRate` on stdout for the host platform. Returns `null` when none is
 * available — the caller throws an actionable error or uses `PushMicSource`.
 * Exported so the cross-platform preflight (`voice:interactive
 * --platform-report`) can report which recorder the host would use.
 */
export function resolveDesktopRecorder(sampleRate, device) {
	const sr = String(sampleRate);
	if (process.platform === "linux") {
		if (whichBin("arecord")) {
			return {
				program: "arecord",
				argv: [
					"-q",
					"-D",
					device ?? "default",
					"-f",
					"S16_LE",
					"-r",
					sr,
					"-c",
					"1",
					"-t",
					"raw",
					"-",
				],
			};
		}
		if (whichBin("parec")) {
			// PulseAudio / PipeWire capture, raw 16-bit LE mono on stdout.
			return {
				program: "parec",
				argv: ["--raw", "--format=s16le", `--rate=${sr}`, "--channels=1"],
			};
		}
		const soxLinux = whichBin("rec") ? "rec" : whichBin("sox") ? "sox" : null;
		if (soxLinux) {
			return {
				program: soxLinux,
				argv: [
					"-q",
					...(soxLinux === "sox" ? ["-d"] : []),
					"-r",
					sr,
					"-c",
					"1",
					"-b",
					"16",
					"-e",
					"signed-integer",
					"-t",
					"raw",
					"-",
				],
			};
		}
		return null;
	}
	if (process.platform === "darwin") {
		const soxMac = whichBin("sox") ? "sox" : whichBin("rec") ? "rec" : null;
		if (soxMac) {
			return {
				program: soxMac,
				argv: [
					"-q",
					...(soxMac === "sox" ? ["-d"] : []),
					"-r",
					sr,
					"-c",
					"1",
					"-b",
					"16",
					"-e",
					"signed-integer",
					"-t",
					"raw",
					"-",
				],
			};
		}
		if (whichBin("ffmpeg")) {
			// avfoundation default audio device → raw PCM16-LE mono on stdout.
			return {
				program: "ffmpeg",
				argv: [
					"-loglevel",
					"error",
					"-f",
					"avfoundation",
					"-i",
					device ?? ":default",
					"-ac",
					"1",
					"-ar",
					sr,
					"-f",
					"s16le",
					"pipe:1",
				],
			};
		}
		return null;
	}
	if (process.platform === "win32") {
		if (whichBin("ffmpeg")) {
			// DirectShow default microphone → raw PCM16-LE mono on stdout. The
			// device name is `audio="<friendly name>"`; `device` overrides it.
			// Without a name ffmpeg's dshow demuxer can't pick a default, so we
			// require either an explicit device or fall back to the common
			// "Microphone" alias; callers that know the device name pass it.
			const dshowDevice = device
				? `audio=${device}`
				: "audio=Microphone (Realtek(R) Audio)";
			return {
				program: "ffmpeg",
				argv: [
					"-loglevel",
					"error",
					"-f",
					"dshow",
					"-i",
					dshowDevice,
					"-ac",
					"1",
					"-ar",
					sr,
					"-f",
					"s16le",
					"pipe:1",
				],
			};
		}
		return null;
	}
	return null;
}
const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_FRAME_MS = 32; // 512 samples @ 16 kHz — matches Silero's window.
function frameSamplesFor(sampleRate, frameMs) {
	return Math.round((sampleRate * frameMs) / 1000);
}
function now() {
	return typeof performance !== "undefined" && performance.now
		? performance.now()
		: Date.now();
}
class BaseMicSource {
	sampleRate;
	frameSamples;
	frameListeners = new Set();
	errorListeners = new Set();
	_running = false;
	constructor(sampleRate, frameSamples) {
		this.sampleRate = sampleRate;
		this.frameSamples = frameSamples;
	}
	get running() {
		return this._running;
	}
	onFrame(listener) {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}
	onError(listener) {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}
	emitFrame(pcm, timestampMs) {
		const frame = { pcm, sampleRate: this.sampleRate, timestampMs };
		for (const l of this.frameListeners) l(frame);
	}
	emitError(error) {
		this._running = false;
		for (const l of this.errorListeners) l(error);
	}
}
/**
 * `MicSource` backed by a recorder subprocess. The recorder is auto-resolved
 * per platform (Linux: `arecord`/`parec`/`sox`; macOS: `sox -d`/`ffmpeg -f
 * avfoundation`; Windows: `ffmpeg -f dshow`); all stream raw PCM16 mono to
 * stdout, which this class re-frames into fixed-size `Float32Array` frames
 * in [-1, 1].
 *
 * When no recorder is available `start()` throws — the renderer's
 * `getUserMedia` path (or the Capacitor `Microphone` plugin on mobile),
 * both feeding a `PushMicSource`, are the no-CLI route.
 */
export class DesktopMicSource extends BaseMicSource {
	program;
	argv;
	proc = null;
	// Carry-over bytes that didn't complete a frame on the last `data` chunk.
	carry = [];
	bytesPerFrame;
	constructor(opts = {}) {
		const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
		const frameMs = opts.frameMs ?? DEFAULT_FRAME_MS;
		const frameSamples = frameSamplesFor(sampleRate, frameMs);
		super(sampleRate, frameSamples);
		this.bytesPerFrame = frameSamples * 2;
		if (opts.program && opts.argv) {
			this.program = opts.program;
			this.argv = opts.argv;
		} else {
			const resolved = resolveDesktopRecorder(sampleRate, opts.device);
			if (resolved && !opts.program) {
				this.program = resolved.program;
				this.argv = resolved.argv;
			} else if (opts.program) {
				// Caller named a program but not argv — give it the resolved argv if
				// the resolved program matches, else an empty argv (it must be a
				// recorder that defaults to raw-PCM-on-stdout, e.g. a wrapper).
				this.program = opts.program;
				this.argv =
					resolved && resolved.program === opts.program ? resolved.argv : [];
			} else {
				this.program = "";
				this.argv = [];
			}
		}
	}
	async start() {
		if (this._running) return;
		if (!this.program) {
			throw new Error(
				`[voice] No CLI mic recorder available on platform '${process.platform}'. ` +
					`Install one (Linux: alsa-utils/pulseaudio/sox; macOS: sox or ffmpeg; ` +
					`Windows: ffmpeg) or feed PCM via PushMicSource (the renderer's ` +
					`getUserMedia path, or the Capacitor Microphone plugin on mobile).`,
			);
		}
		let proc;
		try {
			proc = spawn(this.program, this.argv, {
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			throw new Error(
				`[voice] Failed to spawn mic recorder '${this.program}': ${err instanceof Error ? err.message : String(err)}. Install it (Linux: alsa-utils/sox; macOS: sox or ffmpeg; Windows: ffmpeg) or use PushMicSource.`,
			);
		}
		this.proc = proc;
		const stderrChunks = [];
		proc.stderr?.on("data", (b) => {
			stderrChunks.push(b);
			if (stderrChunks.length > 64) stderrChunks.shift();
		});
		proc.stdout?.on("data", (chunk) => this.ingest(chunk));
		proc.on("error", (err) => {
			this.emitError(
				new Error(
					`[voice] Mic recorder '${this.program}' error: ${err.message}`,
				),
			);
		});
		proc.on("exit", (code, signal) => {
			this.proc = null;
			if (this._running) {
				// Exited while we expected it to be running.
				const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
				this.emitError(
					new Error(
						`[voice] Mic recorder '${this.program}' exited unexpectedly (code=${code} signal=${signal})${stderr ? `: ${stderr}` : ""}`,
					),
				);
			}
		});
		// Confirm the process is alive and producing audio: arecord/sox emit
		// their first PCM chunk within a few hundred ms; if it dies immediately
		// (bad device, missing binary masquerading) the `exit` handler above
		// already fired. We just need to flip `_running` so callers can tee.
		this._running = true;
	}
	async stop() {
		this._running = false;
		const proc = this.proc;
		this.proc = null;
		this.carry.length = 0;
		if (proc && proc.exitCode === null) {
			proc.kill("SIGTERM");
			// Best-effort hard kill if it ignores SIGTERM.
			await new Promise((resolve) => {
				const t = setTimeout(() => {
					if (proc.exitCode === null) proc.kill("SIGKILL");
					resolve();
				}, 250);
				proc.once("exit", () => {
					clearTimeout(t);
					resolve();
				});
			});
		}
	}
	ingest(chunk) {
		const ts = now();
		// Accumulate raw bytes, slice into whole frames.
		for (let i = 0; i < chunk.length; i++) this.carry.push(chunk[i]);
		while (this.carry.length >= this.bytesPerFrame) {
			const bytes = this.carry.splice(0, this.bytesPerFrame);
			const pcm = new Float32Array(this.frameSamples);
			for (let s = 0; s < this.frameSamples; s++) {
				const lo = bytes[s * 2];
				const hi = bytes[s * 2 + 1];
				let v = (hi << 8) | lo;
				if (v >= 0x8000) v -= 0x10000;
				pcm[s] = v / 0x8000;
			}
			this.emitFrame(pcm, ts);
		}
	}
}
/**
 * `MicSource` driven by an external producer (Discord opus-decoded PCM, the
 * Electrobun renderer's `getUserMedia` chunks, a mobile capture callback,
 * or a test). The producer calls `push(pcm)` (any sample count, mono,
 * already at `sampleRate`); this class re-frames it to `frameSamples`-long
 * frames and emits them. `start()` / `stop()` just toggle the gate.
 */
export class PushMicSource extends BaseMicSource {
	// Pending samples that didn't complete a frame.
	pending = new Float32Array(0);
	pendingStartTimestampMs = 0;
	constructor(opts = {}) {
		const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
		const frameSamples =
			opts.frameSamples ??
			frameSamplesFor(sampleRate, opts.frameMs ?? DEFAULT_FRAME_MS);
		super(sampleRate, frameSamples);
	}
	async start() {
		this._running = true;
	}
	async stop() {
		this._running = false;
		this.pending = new Float32Array(0);
		this.pendingStartTimestampMs = 0;
	}
	/**
	 * Feed mono PCM in [-1, 1] at `sampleRate`. Re-frames and emits. The
	 * timestamp is the first sample's timestamp; emitted frames advance by
	 * their sample offset so a large pushed buffer still presents a real audio
	 * timeline to VAD/ASR.
	 */
	push(pcm, timestampMs = now()) {
		if (!this._running) return;
		const mergedStartTimestampMs =
			this.pending.length > 0 ? this.pendingStartTimestampMs : timestampMs;
		const merged = new Float32Array(this.pending.length + pcm.length);
		merged.set(this.pending, 0);
		merged.set(pcm, this.pending.length);
		let offset = 0;
		while (merged.length - offset >= this.frameSamples) {
			const frame = merged.slice(offset, offset + this.frameSamples);
			const frameTimestampMs =
				mergedStartTimestampMs + (offset / this.sampleRate) * 1000;
			offset += this.frameSamples;
			this.emitFrame(frame, frameTimestampMs);
		}
		this.pending = merged.slice(offset);
		this.pendingStartTimestampMs =
			this.pending.length > 0
				? mergedStartTimestampMs + (offset / this.sampleRate) * 1000
				: 0;
	}
	/** Feed mono PCM16 little-endian bytes (Discord / browser path). */
	pushPcm16(bytes, timestampMs = now()) {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const n = Math.floor(bytes.byteLength / 2);
		const out = new Float32Array(n);
		for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
		this.push(out, timestampMs);
	}
	/** Surface a fatal producer-side error to subscribers. */
	fail(error) {
		this.emitError(error);
	}
}
/**
 * Wire a `MicSource` to a `PcmRingBuffer` (the buffer the ASR reads PCM
 * from). Returns the ring buffer and an unsubscribe function. The ring
 * buffer's `onOverflow` is forwarded so callers can apply backpressure.
 */
export function pipeMicToRingBuffer(source, sink, opts = {}) {
	const capacity = opts.capacitySamples ?? source.sampleRate * 8;
	const ringBuffer = new PcmRingBuffer(capacity, source.sampleRate, sink, {
		onOverflow: opts.onOverflow,
	});
	const off = source.onFrame((frame) => ringBuffer.write(frame.pcm));
	return { ringBuffer, unsubscribe: off };
}
//# sourceMappingURL=mic-source.js.map
