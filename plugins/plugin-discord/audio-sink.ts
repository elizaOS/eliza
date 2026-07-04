/**
 * Abstract audio-sink contract for voice playback — the interface and base
 * class a concrete sink implements to stream lane-routed audio into a Discord
 * voice connection.
 */
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import type { DiscordAudioLane } from "./audio-lanes";

export type DiscordAudioSinkStatus =
	| "connected"
	| "disconnected"
	| "reconnecting";

export interface DiscordAudioPlaybackHandle {
	finished: Promise<void>;
	cancelled: Promise<void>;
	abort(): void;
}

export interface DiscordAudioSinkPlayOptions {
	lane?: DiscordAudioLane;
	interrupt?: boolean;
	mix?: boolean;
	signal?: AbortSignal;
}

export interface IDiscordAudioSink {
	readonly id: string;
	readonly status: DiscordAudioSinkStatus;
	play(
		stream: Readable,
		options?: DiscordAudioSinkPlayOptions,
	): Promise<DiscordAudioPlaybackHandle>;
	stop(lane?: DiscordAudioLane): Promise<void>;
	destroy(): void;
	on(
		event: "statusChange",
		listener: (status: DiscordAudioSinkStatus) => void,
	): this;
	on(event: "error", listener: (error: Error) => void): this;
}

export abstract class DiscordAudioSinkBase
	extends EventEmitter
	implements IDiscordAudioSink
{
	abstract readonly id: string;
	abstract get status(): DiscordAudioSinkStatus;
	abstract play(
		stream: Readable,
		options?: DiscordAudioSinkPlayOptions,
	): Promise<DiscordAudioPlaybackHandle>;
	abstract stop(lane?: DiscordAudioLane): Promise<void>;
	abstract destroy(): void;
}
