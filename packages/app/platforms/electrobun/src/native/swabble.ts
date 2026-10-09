/**
 * Swabble (Wake Word) Native Module for Electrobun
 *
 * Wake-word audio passthrough: receives base64-encoded Float32 PCM chunks
 * (16 kHz mono) from the renderer and forwards them straight back via
 * `swabble:audioChunkPush` so the renderer can run the Web Speech API
 * pipeline. The previous whisper.cpp transcription path has been removed
 * (it vendored a second GGML and is not part of the local-inference
 * contract); native ASR is delivered exclusively through the fused
 * `libelizainference` build.
 */

import type { SendToWebview } from "../types.js";

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
// SwabbleManager
// ============================================================================

export class SwabbleManager {
	private sendToWebview: SendToWebview | null = null;
	private listening = false;
	private config: SwabbleConfig = {
		triggers: ["hey eliza", "eliza"],
		minPostTriggerGap: 0.45,
		minCommandLength: 1,
		enabled: true,
	};

	setSendToWebview(fn: SendToWebview): void {
		this.sendToWebview = fn;
	}

	async start(params?: {
		config?: Partial<SwabbleConfig>;
	}): Promise<{ started: boolean; error?: string }> {
		if (params?.config) {
			this.config = { ...this.config, ...params.config };
		}
		this.listening = true;
		this.sendToWebview?.("swabble:stateChange", { listening: true });
		return { started: true };
	}

	async stop(): Promise<void> {
		this.listening = false;
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
	}

	async audioChunk(options: { data: string }): Promise<void> {
		if (!this.config.enabled) return;
		if (!this.listening) return;
		// Forward chunks to the renderer; Web Speech API in the renderer handles
		// recognition. The native whisper.cpp pipeline has been removed.
		this.sendToWebview?.("swabble:audioChunkPush", { data: options.data });
	}

	dispose(): void {
		this.listening = false;
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
