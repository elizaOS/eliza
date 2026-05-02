/**
 * Swabble (Wake Word) Native Module for Electrobun
 *
 * Wake word detection using whisper.cpp via Bun.spawn for audio processing.
 * Audio arrives as base64-encoded Float32 PCM chunks (16kHz mono) from the
 * renderer. Chunks accumulate until ~3 seconds of audio is buffered, then
 * the buffer is transcribed and checked for wake words.
 *
 * Fallback: if the whisper.cpp binary is missing, raw audio chunks are pushed
 * back to the renderer via swabbleAudioChunkPush so the renderer can handle
 * them (e.g. via Web Speech API).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SendToWebview } from "../types.js";
import type { WhisperResult } from "./whisper";
import {
	isWhisperBinaryAvailable,
	transcribeBunSpawn,
	writeWavFile,
} from "./whisper";

// ============================================================================
// Types
// ============================================================================

interface SwabbleConfig {
	triggers: string[];
	minPostTriggerGap: number;
	minCommandLength: number;
	enabled: boolean;
}

// ============================================================================
// WakeWordGate — processes wake-word phrase matching from Whisper transcripts.
// ============================================================================

class WakeWordGate {
	private triggers: string[];
	private minPostTriggerGap: number;
	private minCommandLength: number;

	constructor(config: SwabbleConfig) {
		this.triggers = config.triggers.map((t) => t.toLowerCase().trim());
		this.minPostTriggerGap = config.minPostTriggerGap;
		this.minCommandLength = config.minCommandLength;
	}

	updateConfig(config: Partial<SwabbleConfig>): void {
		if (config.triggers) {
			this.triggers = config.triggers.map((t) => t.toLowerCase().trim());
		}
		if (config.minPostTriggerGap !== undefined) {
			this.minPostTriggerGap = config.minPostTriggerGap;
		}
		if (config.minCommandLength !== undefined) {
			this.minCommandLength = config.minCommandLength;
		}
	}

	/**
	 * Match wake word in Whisper result using timing data.
	 * Returns a wake word event if found, null otherwise.
	 */
	match(result: WhisperResult): {
		trigger: string;
		command: string;
		transcript: string;
		postGap: number;
	} | null {
		const segments = result.segments;
		if (segments.length === 0) return null;

		// Build word list with timing
		const words: Array<{ text: string; start: number; end: number }> = [];
		for (const segment of segments) {
			if (segment.tokens) {
				for (const token of segment.tokens) {
					const text = token.text.trim().toLowerCase();
					if (text) {
						words.push({ text, start: token.start, end: token.end });
					}
				}
			} else {
				const segWords = segment.text.split(/\s+/).filter((w) => w.trim());
				const duration = segment.end - segment.start;
				const wordDuration = duration / Math.max(segWords.length, 1);
				for (let i = 0; i < segWords.length; i++) {
					words.push({
						text: segWords[i].toLowerCase(),
						start: segment.start + i * wordDuration,
						end: segment.start + (i + 1) * wordDuration,
					});
				}
			}
		}

		for (const trigger of this.triggers) {
			const triggerWords = trigger.split(/\s+/);
			const triggerMatch = this.findTriggerMatch(words, triggerWords);
			if (!triggerMatch) continue;

			const { triggerEndIndex, triggerEndTime } = triggerMatch;
			const commandWords = words.slice(triggerEndIndex + 1);
			if (commandWords.length < this.minCommandLength) continue;

			const firstCommandTime = commandWords[0].start;
			// Timing is in seconds from whisper.cpp output
			const postGap = firstCommandTime - triggerEndTime;
			if (postGap < this.minPostTriggerGap) continue;

			const command = commandWords.map((w) => w.text).join(" ");
			return { trigger, command, transcript: result.text, postGap };
		}

		return null;
	}

	private findTriggerMatch(
		words: Array<{ text: string; start: number; end: number }>,
		triggerWords: string[],
	): { triggerEndIndex: number; triggerEndTime: number } | null {
		for (let i = 0; i <= words.length - triggerWords.length; i++) {
			let matches = true;
			for (let j = 0; j < triggerWords.length; j++) {
				if (!this.fuzzyMatch(words[i + j].text, triggerWords[j])) {
					matches = false;
					break;
				}
			}
			if (matches) {
				const endIndex = i + triggerWords.length - 1;
				return {
					triggerEndIndex: endIndex,
					triggerEndTime: words[endIndex].end,
				};
			}
		}
		return null;
	}

	private fuzzyMatch(word: string, target: string): boolean {
		if (word === target) return true;
		const variations: Record<string, string[]> = {
			eliza: ["melody", "eliza", "my lady", "malady"],
			alexa: ["alexia", "alexis"],
			hey: ["hay", "hi"],
			ok: ["okay", "o.k."],
		};
		const targetVariations = variations[target] ?? [];
		return targetVariations.includes(word);
	}
}

// ============================================================================
// SwabbleManager
// ============================================================================

// 3 seconds of audio at 16kHz = 48000 Float32 samples = 192000 bytes
const AUDIO_BUFFER_THRESHOLD_BYTES = 16000 * 3 * 4;

export class SwabbleManager {
	private sendToWebview: SendToWebview | null = null;
	private listening = false;
	private config: SwabbleConfig = {
		triggers: ["hey eliza", "eliza"],
		minPostTriggerGap: 0.45,
		minCommandLength: 1,
		enabled: true,
	};
	private wakeGate: WakeWordGate = new WakeWordGate(this.config);
	private audioBuffer: Buffer[] = [];
	private audioBufferSize = 0;
	private processing = false;

	setSendToWebview(fn: SendToWebview): void {
		this.sendToWebview = fn;
	}

	async start(params?: {
		config?: Partial<SwabbleConfig>;
	}): Promise<{ started: boolean; error?: string }> {
		if (!isWhisperBinaryAvailable()) {
			return {
				started: false,
				error:
					"whisper.cpp binary not found. Install whisper-node and compile the binary.",
			};
		}

		// Apply config from plugin if provided (takes precedence over defaults)
		if (params?.config) {
			this.config = { ...this.config, ...params.config };
			this.wakeGate.updateConfig(this.config);
		}

		this.listening = true;
		this.audioBuffer = [];
		this.audioBufferSize = 0;
		this.sendToWebview?.("swabble:stateChange", { listening: true });
		return { started: true };
	}

	async stop(): Promise<void> {
		this.listening = false;
		this.audioBuffer = [];
		this.audioBufferSize = 0;
		this.sendToWebview?.("swabble:stateChange", { listening: false });
	}

	async isListening() {
		return { listening: this.listening };
	}

	async getConfig(): Promise<Record<string, unknown>> {
		return { ...this.config };
	}

	async updateConfig(updates: Record<string, unknown>): Promise<void> {
		Object.assign(this.config, updates);
		this.wakeGate.updateConfig(this.config);
	}

	async isWhisperAvailableCheck() {
		return { available: isWhisperBinaryAvailable() };
	}

	async audioChunk(options: { data: string }): Promise<void> {
		if (!this.config.enabled) return;

		if (!this.listening) return;

		// If whisper binary not available, push chunk back to renderer as fallback
		if (!isWhisperBinaryAvailable()) {
			this.sendToWebview?.("swabble:audioChunkPush", { data: options.data });
			return;
		}

		// Decode base64 Float32 PCM and accumulate
		const chunkBuffer = Buffer.from(options.data, "base64");
		this.audioBuffer.push(chunkBuffer);
		this.audioBufferSize += chunkBuffer.length;

		// Process when we have enough audio (~3 seconds)
		if (
			this.audioBufferSize >= AUDIO_BUFFER_THRESHOLD_BYTES &&
			!this.processing
		) {
			await this.processBuffer();
		}
	}

	private async processBuffer(): Promise<void> {
		if (this.processing || this.audioBuffer.length === 0) return;
		this.processing = true;

		// Keep the last 50% of the buffer for overlap (catches wake words at boundaries).
		// Grab current buffer but retain the trailing half for the next window.
		const allBuffers = [...this.audioBuffer];
		const combined = Buffer.concat(allBuffers);

		// Retain trailing half for overlap
		const overlapBytes = Math.floor(combined.byteLength / 2);
		const overlapBuffer = combined.subarray(combined.byteLength - overlapBytes);
		this.audioBuffer = [Buffer.from(overlapBuffer)];
		this.audioBufferSize = overlapBytes;

		try {
			// Safe Float32 conversion — avoids alignment issues from Buffer pool offsets.
			// Buffer.concat() byteOffset may not be 4-byte aligned; copy through DataView.
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
				`elizaos-swabble-${Date.now()}.wav`,
			);
			writeWavFile(tmpPath, float32, 16000, 1);

			// Transcribe
			const result = await transcribeBunSpawn(tmpPath);

			// Clean up temp file
			try {
				fs.unlinkSync(tmpPath);
			} catch {}

			if (!result) return;

			this.sendToWebview?.("swabble:transcript", {
				transcript: result.text,
				segments: result.segments.map((segment) => ({
					text: segment.text,
					start: segment.start,
					duration: Math.max(0, segment.end - segment.start),
					isFinal: true,
				})),
				isFinal: true,
			});

			// Check for wake word
			const match = this.wakeGate.match(result);
			if (match) {
				this.sendToWebview?.("swabble:wakeWord", {
					wakeWord: match.trigger,
					command: match.command,
					transcript: match.transcript,
					postGap: match.postGap,
				});
			}
		} catch (err) {
			this.sendToWebview?.("swabble:error", {
				code: "transcription_failed",
				message: err instanceof Error ? err.message : String(err),
				recoverable: true,
			});
			console.error("[Swabble] processBuffer error:", err);
		} finally {
			this.processing = false;
		}
	}

	dispose(): void {
		this.listening = false;
		this.audioBuffer = [];
		this.audioBufferSize = 0;
		this.sendToWebview = null;
	}
}

let swabbleManager: SwabbleManager | null = null;

export function getSwabbleManager(): SwabbleManager {
	if (!swabbleManager) {
		swabbleManager = new SwabbleManager();
	}
	return swabbleManager;
}
