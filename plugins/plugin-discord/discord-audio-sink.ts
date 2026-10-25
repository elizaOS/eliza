/**
 * Concrete audio sink that plays lane-routed audio into a registered Discord
 * voice target, implementing `DiscordAudioSinkBase`.
 */
import type { Readable } from "node:stream";
import { logger } from "@elizaos/core";
import type { DiscordAudioLane } from "./audio-lanes";
import {
	type DiscordAudioPlaybackHandle,
	DiscordAudioSinkBase,
	type DiscordAudioSinkPlayOptions,
	type DiscordAudioSinkStatus,
} from "./audio-sink";
import type { DiscordVoiceTarget } from "./voice-target-registry";

export class DiscordVoiceTargetAudioSink extends DiscordAudioSinkBase {
	readonly id: string;
	private target: DiscordVoiceTarget;
	private destroyed = false;

	constructor(target: DiscordVoiceTarget) {
		super();
		this.target = target;
		this.id = `discord:${target.id}`;
	}

	get status(): DiscordAudioSinkStatus {
		return this.destroyed ? "disconnected" : this.target.getStatus();
	}

	async play(
		stream: Readable,
		options?: DiscordAudioSinkPlayOptions,
	): Promise<DiscordAudioPlaybackHandle> {
		if (this.destroyed) {
			throw new Error(`Discord audio sink ${this.id} has been destroyed`);
		}
		try {
			return await this.target.play(stream, options);
		} catch (error) {
			const normalized =
				error instanceof Error ? error : new Error(String(error));
			this.emit("error", normalized);
			throw normalized;
		}
	}

	async stop(lane?: DiscordAudioLane): Promise<void> {
		if (this.destroyed) {
			return;
		}
		await this.stopTarget(lane);
	}

	private async stopTarget(lane?: DiscordAudioLane): Promise<void> {
		try {
			await this.target.stop(lane);
		} catch (error) {
			const normalized =
				error instanceof Error ? error : new Error(String(error));
			logger.warn(
				{
					src: "plugin:discord:audio-sink",
					targetId: this.target.id,
					error: normalized.message,
				},
				"Failed to stop Discord audio sink",
			);
			this.emit("error", normalized);
		}
	}

	destroy(): void {
		if (this.destroyed) {
			return;
		}
		this.destroyed = true;
		void this.stopTarget();
		this.emit("statusChange", "disconnected");
		this.removeAllListeners();
	}
}
