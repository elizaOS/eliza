/**
 * TalkMode Native Module for Electrobun
 *
 * Provides text-to-speech via ElevenLabs API (fetch-based, works in Bun) or
 * the platform's system voice (say / espeak / PowerShell). Speech-to-text is
 * delegated to the renderer's Web Speech API: the native module forwards
 * audio chunks back through `talkmode:audioChunkPush` instead of running a
 * native ASR. The previous whisper.cpp pipeline has been removed (it
 * vendored a second GGML and is not part of the local-inference contract);
 * native ASR is delivered exclusively through the fused libelizainference
 * build.
 */

import type { TalkModeConfig, TalkModeState } from "../rpc-schema";
import type { SendToWebview } from "../types.js";
import { diagnosticLog } from "./agent";

function talkmodeLog(message: string): void {
	diagnosticLog(`[TalkMode] ${message}`);
}

export class TalkModeManager {
	private sendToWebview: SendToWebview | null = null;
	private state: TalkModeState = "idle";
	private speaking = false;
	private config: TalkModeConfig = {
		engine: "web",
		modelSize: "base",
		language: "en",
	};
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

	async start() {
		talkmodeLog(
			`start platform=${process.platform} engine=${this.config.engine ?? "web"}`,
		);
		this.setState("listening");
		return {
			available: true,
			reason: "Using Web Speech API for STT (native whisper pipeline removed)",
		};
	}

	async stop(): Promise<void> {
		talkmodeLog(`stop state=${this.state}`);
		this.setState("idle");
		this.speaking = false;
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

	async updateConfig(config: TalkModeConfig): Promise<void> {
		Object.assign(this.config, config);
		talkmodeLog(
			`updateConfig engine=${this.config.engine ?? "unset"} modelSize=${this.config.modelSize ?? "unset"} language=${this.config.language ?? "unset"}`,
		);
	}

	async audioChunk(options: { data: string }): Promise<void> {
		// Only forward audio while listening — Web Speech API in the renderer
		// drives recognition; the native whisper.cpp pipeline has been removed.
		if (this.state !== "listening") {
			return;
		}
		this.sendToWebview?.("talkmodeAudioChunkPush", { data: options.data });
	}

	dispose(): void {
		this.speaking = false;
		this.state = "idle";
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
