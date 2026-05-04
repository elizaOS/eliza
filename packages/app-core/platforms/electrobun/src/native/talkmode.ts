/**
 * TalkMode Native Module for Electrobun
 *
 * Provides text-to-speech via ElevenLabs API (fetch-based, works in Bun)
 * and speech-to-text via Whisper (if available) or Web Speech API fallback.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TalkModeConfig, TalkModeState } from "../rpc-schema";
import type { SendToWebview } from "../types.js";
import { diagnosticLog } from "./agent";
import {
	isWhisperAvailable,
	transcribeBunSpawn,
	writeWavFile,
} from "./whisper";

const TALKMODE_SAMPLE_RATE = 16000;
const FLOAT32_BYTES_PER_SAMPLE = 4;
const TALKMODE_CHUNK_WINDOW_SECONDS = 1.25;
const TALKMODE_MIN_FLUSH_SECONDS = 0.2;
const TALKMODE_OVERLAP_RATIO = 0.5;
const TALKMODE_AUDIO_BUFFER_THRESHOLD =
	TALKMODE_SAMPLE_RATE *
	TALKMODE_CHUNK_WINDOW_SECONDS *
	FLOAT32_BYTES_PER_SAMPLE;
const TALKMODE_MIN_FLUSH_BYTES =
	TALKMODE_SAMPLE_RATE * TALKMODE_MIN_FLUSH_SECONDS * FLOAT32_BYTES_PER_SAMPLE;

function talkmodeLog(message: string): void {
	diagnosticLog(`[TalkMode] ${message}`);
}

export class TalkModeManager {
	private sendToWebview: SendToWebview | null = null;
	private state: TalkModeState = "idle";
	private speaking = false;
	private config: TalkModeConfig = {
		engine: isWhisperAvailable() ? "whisper" : "web",
		modelSize: "base",
		language: "en",
	};
	private _audioBuffer: Buffer[] = [];
	private _audioBufferSize = 0;
	private _processing = false;
	/** In-flight system TTS process — killed by stopSpeaking(). */
	private _speakProc: ReturnType<typeof Bun.spawn> | null = null;
	/** AbortController for in-flight ElevenLabs fetch — aborted by stopSpeaking(). */
	private _speakAbort: AbortController | null = null;

	setSendToWebview(fn: SendToWebview): void {
		this.sendToWebview = fn;
	}

	private setState(newState: TalkModeState): void {
		this.state = newState;
		this.sendToWebview?.("talkmodeStateChanged", { state: newState });
	}

	private async _waitForProcessing(): Promise<void> {
		while (this._processing) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	async start() {
		const whisperOk = isWhisperAvailable();
		if (!whisperOk && this.config.engine === "whisper") {
			this.config.engine = "web";
		}

		talkmodeLog(
			`start platform=${process.platform} whisper=${whisperOk} engine=${this.config.engine}`,
		);
		this.setState("listening");
		return {
			available: true,
			reason: whisperOk
				? undefined
				: "Using Web Speech API (Whisper unavailable in Bun)",
		};
	}

	async stop(): Promise<void> {
		talkmodeLog(
			`stop state=${this.state} bufferedBytes=${this._audioBufferSize} processing=${this._processing}`,
		);
		await this._waitForProcessing();
		if (this._audioBufferSize >= TALKMODE_MIN_FLUSH_BYTES) {
			await this._processBuffer({ flush: true });
		}
		this.setState("idle");
		this.speaking = false;
		this._audioBuffer = [];
		this._audioBufferSize = 0;
	}

	async speak(options: {
		text: string;
		directive?: Record<string, unknown>;
	}): Promise<void> {
		const apiKey = process.env.ELEVEN_LABS_API_KEY?.trim();
		talkmodeLog(
			`speak chars=${options.text.length} engine=${apiKey ? "elevenlabs" : "system"}`,
		);
		if (apiKey) {
			await this._speakElevenLabs(options, apiKey);
		} else {
			// Default: system TTS (no API key required, works on all platforms)
			await this._speakSystem(options.text);
		}
	}

	/**
	 * System TTS via platform-native voice synthesis.
	 * Used when ELEVEN_LABS_API_KEY is not configured.
	 * Audio plays directly through system speakers — no streaming to renderer.
	 */
	private async _speakSystem(text: string): Promise<void> {
		this.speaking = true;
		this.setState("speaking");
		try {
			let proc: ReturnType<typeof Bun.spawn>;
			if (process.platform === "darwin") {
				proc = Bun.spawn(["say", text], { stderr: "pipe" });
			} else if (process.platform === "linux") {
				proc = Bun.spawn(["espeak", text], { stderr: "pipe" });
			} else {
				// Windows: PowerShell speech synthesizer.
				// Pass text via env var to avoid command-injection — never interpolate
				// user-controlled strings into the -Command argument.
				proc = Bun.spawn(
					[
						"powershell",
						"-NoProfile",
						"-Command",
						"Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak($env:ELIZA_TTS_TEXT)",
					],
					{
						stderr: "pipe",
						env: { ...process.env, ELIZA_TTS_TEXT: text },
					},
				);
			}
			this._speakProc = proc;
			await proc.exited;
			this.sendToWebview?.("talkmodeSpeakComplete");
		} catch (err) {
			console.error("[TalkMode] System TTS error:", err);
			this.setState("error");
		} finally {
			this._speakProc = null;
			this.speaking = false;
			if (this.state !== "error") {
				this.setState("idle");
			}
		}
	}

	/**
	 * ElevenLabs TTS — used when ELEVEN_LABS_API_KEY is set.
	 * Streams audio chunks to the renderer via talkmodeAudioChunkPush.
	 * Model defaults to eleven_v3. Override via directive.modelId if needed.
	 */
	private async _speakElevenLabs(
		options: { text: string; directive?: Record<string, unknown> },
		apiKey: string,
	): Promise<void> {
		this.speaking = true;
		this.setState("speaking");

		const abort = new AbortController();
		this._speakAbort = abort;

		try {
			const voiceId =
				(options.directive?.voiceId as string) ??
				this.config.voiceId ??
				"21m00Tcm4TlvDq8ikWAM";

			const resp = await fetch(
				`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
				{
					method: "POST",
					signal: abort.signal,
					headers: {
						"xi-api-key": apiKey,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						text: options.text,
						model_id: (options.directive?.modelId as string) ?? "eleven_v3",
						voice_settings: {
							stability: (options.directive?.stability as number) ?? 0.5,
							similarity_boost:
								(options.directive?.similarity as number) ?? 0.75,
						},
					}),
				},
			);

			if (!resp.ok) {
				const errorMsg = `ElevenLabs API error: ${resp.status} ${resp.statusText}`;
				console.error(`[TalkMode] ${errorMsg}`);
				this.sendToWebview?.("talkmodeError", {
					source: "elevenlabs",
					message: errorMsg,
				});
				this.setState("error");
				return;
			}

			if (resp.body) {
				const reader = resp.body.getReader();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const base64 = Buffer.from(value).toString("base64");
					this.sendToWebview?.("talkmodeAudioChunkPush", { data: base64 });
				}
			}

			this.sendToWebview?.("talkmodeSpeakComplete");
		} catch (err) {
			// AbortError is expected when stopSpeaking() cancels the fetch — not an error.
			if (err instanceof Error && err.name === "AbortError") {
				console.log("[TalkMode] ElevenLabs TTS aborted by stopSpeaking()");
			} else {
				const errorMsg = err instanceof Error ? err.message : String(err);
				console.error("[TalkMode] ElevenLabs TTS error:", err);
				this.sendToWebview?.("talkmodeError", {
					source: "elevenlabs",
					message: errorMsg,
				});
				this.setState("error");
			}
		} finally {
			this._speakAbort = null;
			this.speaking = false;
			if (this.state !== "error") {
				this.setState("idle");
			}
		}
	}

	async stopSpeaking(): Promise<void> {
		talkmodeLog("stopSpeaking");
		// Kill in-flight system TTS process (say / espeak / PowerShell).
		if (this._speakProc) {
			try {
				this._speakProc.kill();
			} catch {
				/* already exited */
			}
			this._speakProc = null;
		}
		// Abort in-flight ElevenLabs fetch/stream.
		if (this._speakAbort) {
			this._speakAbort.abort();
			this._speakAbort = null;
		}
		this.speaking = false;
		this.setState("idle");
	}

	async getState() {
		return { state: this.state };
	}

	async isEnabled() {
		return { enabled: true };
	}

	async isSpeaking() {
		return { speaking: this.speaking };
	}

	async getWhisperInfo() {
		const available = isWhisperAvailable();
		talkmodeLog(
			`getWhisperInfo available=${available} modelSize=${this.config.modelSize}`,
		);
		return {
			available,
			modelSize: this.config.modelSize,
		};
	}

	async isWhisperAvailableCheck() {
		const available = isWhisperAvailable();
		talkmodeLog(`isWhisperAvailable ${available}`);
		return { available };
	}

	async updateConfig(config: TalkModeConfig): Promise<void> {
		Object.assign(this.config, config);
		talkmodeLog(
			`updateConfig engine=${this.config.engine ?? "unset"} modelSize=${this.config.modelSize ?? "unset"} language=${this.config.language ?? "unset"}`,
		);
	}

	async audioChunk(options: { data: string }): Promise<void> {
		// Only process audio when actively listening or speaking (not idle/error)
		if (this.state !== "listening" && this.state !== "speaking") {
			talkmodeLog(`audioChunk ignored state=${this.state}`);
			return;
		}

		// Decode base64 Float32 PCM and accumulate
		const chunkBuffer = Buffer.from(options.data, "base64");
		const previousBufferSize = this._audioBufferSize;
		this._audioBuffer.push(chunkBuffer);
		this._audioBufferSize += chunkBuffer.length;
		if (previousBufferSize === 0) {
			talkmodeLog(`audioChunk stream-start bytes=${chunkBuffer.length}`);
		}

		// Process in smaller rolling windows so text lands in the composer quickly.
		if (
			this._audioBufferSize >= TALKMODE_AUDIO_BUFFER_THRESHOLD &&
			!this._processing
		) {
			talkmodeLog(
				`audioChunk process-threshold bufferedBytes=${this._audioBufferSize}`,
			);
			await this._processBuffer();
		}
	}

	private async _processBuffer(options?: { flush?: boolean }): Promise<void> {
		if (this._processing || this._audioBuffer.length === 0) return;
		this._processing = true;
		const flush = options?.flush === true;

		// Keep trailing overlap while streaming so we do not clip phrase boundaries.
		const allBuffers = [...this._audioBuffer];
		const combined = Buffer.concat(allBuffers);
		if (!flush) {
			const overlapBytes = Math.min(
				Math.floor(combined.byteLength * TALKMODE_OVERLAP_RATIO),
				combined.byteLength,
			);
			if (overlapBytes > 0) {
				const overlapBuffer = combined.subarray(
					combined.byteLength - overlapBytes,
				);
				this._audioBuffer = [Buffer.from(overlapBuffer)];
				this._audioBufferSize = overlapBytes;
			} else {
				this._audioBuffer = [];
				this._audioBufferSize = 0;
			}
		} else {
			this._audioBuffer = [];
			this._audioBufferSize = 0;
		}

		try {
			talkmodeLog(
				`_processBuffer begin flush=${flush} bufferedBytes=${combined.byteLength}`,
			);
			// Safe Float32 conversion - avoids alignment issues from Buffer pool offsets.
			const numSamples = combined.byteLength >>> 2; // divide by 4
			const float32 = new Float32Array(numSamples);
			const dv = new DataView(
				combined.buffer,
				combined.byteOffset,
				combined.byteLength,
			);
			for (let i = 0; i < numSamples; i++) {
				float32[i] = dv.getFloat32(i * 4, true); // little-endian
			}

			// Write to temp WAV file
			const tmpPath = path.join(
				os.tmpdir(),
				`elizaos-talkmode-${Date.now()}.wav`,
			);
			writeWavFile(tmpPath, float32, 16000, 1);

			// Transcribe
			const result = await transcribeBunSpawn(tmpPath);

			// Clean up temp file
			try {
				fs.unlinkSync(tmpPath);
			} catch {}

			if (!result?.text?.trim()) {
				talkmodeLog(`transcribe empty flush=${flush}`);
				return;
			}

			talkmodeLog(
				`transcribe success chars=${result.text.trim().length} segments=${result.segments.length} flush=${flush}`,
			);

			// Emit transcript to renderer
			this.sendToWebview?.("talkmodeTranscript", {
				text: result.text,
				segments: result.segments.map((s) => ({
					text: s.text,
					start: s.start,
					end: s.end,
				})),
				isFinal: flush,
			});
		} catch (err) {
			talkmodeLog(
				`_processBuffer error ${err instanceof Error ? err.message : String(err)}`,
			);
			this.sendToWebview?.("talkmodeError", {
				code: "transcription_failed",
				message: err instanceof Error ? err.message : String(err),
				recoverable: true,
			});
			console.error("[TalkMode] _processBuffer error:", err);
		} finally {
			this._processing = false;
		}
	}

	dispose(): void {
		this.speaking = false;
		this.state = "idle";
		this._audioBuffer = [];
		this._audioBufferSize = 0;
		this.sendToWebview = null;
	}
}

let talkModeManager: TalkModeManager | null = null;

export function getTalkModeManager(): TalkModeManager {
	if (!talkModeManager) {
		talkModeManager = new TalkModeManager();
	}
	return talkModeManager;
}
