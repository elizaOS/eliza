import type { Readable } from "node:stream";
import type { BaseGuildVoiceChannel } from "discord.js";
import type { DiscordAudioLane, DiscordAudioLaneConfig } from "./audio-lanes";
import type {
	DiscordAudioPlaybackHandle,
	DiscordAudioSinkPlayOptions,
	DiscordAudioSinkStatus,
} from "./audio-sink";

export interface DiscordVoicePlaybackOptions
	extends DiscordAudioSinkPlayOptions {
	lane?: DiscordAudioLane;
}

export interface DiscordVoiceTarget {
	id: string;
	accountId: string;
	botId: string;
	botAlias?: string;
	guildId: string;
	guildName?: string;
	channelId: string;
	channelName: string;
	play(
		stream: Readable,
		options?: DiscordVoicePlaybackOptions,
	): Promise<DiscordAudioPlaybackHandle>;
	stop(lane?: DiscordAudioLane): Promise<void>;
	getStatus(): DiscordAudioSinkStatus;
	getLaneConfig(lane?: DiscordAudioLane): DiscordAudioLaneConfig;
}

export interface DiscordVoiceTargetRegistration {
	accountId: string;
	botId: string;
	botAlias?: string;
	channel: BaseGuildVoiceChannel;
	play(
		stream: Readable,
		options?: DiscordVoicePlaybackOptions,
	): Promise<DiscordAudioPlaybackHandle>;
	stop(lane?: DiscordAudioLane): Promise<void>;
	getStatus(): DiscordAudioSinkStatus;
	getLaneConfig(lane?: DiscordAudioLane): DiscordAudioLaneConfig;
}

export class DiscordVoiceTargetRegistry {
	private readonly targets = new Map<string, DiscordVoiceTarget>();

	register(registration: DiscordVoiceTargetRegistration): DiscordVoiceTarget {
		const { channel } = registration;
		const id = DiscordVoiceTargetRegistry.makeId(
			registration.accountId,
			channel.guild.id,
			channel.id,
		);
		const target: DiscordVoiceTarget = {
			id,
			accountId: registration.accountId,
			botId: registration.botId,
			botAlias: registration.botAlias,
			guildId: channel.guild.id,
			guildName: channel.guild.name,
			channelId: channel.id,
			channelName: channel.name,
			play: registration.play,
			stop: registration.stop,
			getStatus: registration.getStatus,
			getLaneConfig: registration.getLaneConfig,
		};
		this.targets.set(id, target);
		return target;
	}

	unregister(accountId: string, guildId: string, channelId: string): void {
		this.targets.delete(
			DiscordVoiceTargetRegistry.makeId(accountId, guildId, channelId),
		);
	}

	unregisterAccount(accountId: string): void {
		for (const [id, target] of this.targets) {
			if (target.accountId === accountId) {
				this.targets.delete(id);
			}
		}
	}

	get(targetId: string): DiscordVoiceTarget | null {
		return this.targets.get(targetId) ?? null;
	}

	find(query: {
		accountId?: string | null;
		guildId?: string | null;
		channelId?: string | null;
	}): DiscordVoiceTarget | null {
		if (query.accountId && query.guildId && query.channelId) {
			return (
				this.targets.get(
					DiscordVoiceTargetRegistry.makeId(
						query.accountId,
						query.guildId,
						query.channelId,
					),
				) ?? null
			);
		}

		return (
			this.list().find((target) => {
				if (query.accountId && target.accountId !== query.accountId) {
					return false;
				}
				if (query.guildId && target.guildId !== query.guildId) {
					return false;
				}
				if (query.channelId && target.channelId !== query.channelId) {
					return false;
				}
				return true;
			}) ?? null
		);
	}

	list(): DiscordVoiceTarget[] {
		return Array.from(this.targets.values());
	}

	clear(): void {
		this.targets.clear();
	}

	static makeId(accountId: string, guildId: string, channelId: string): string {
		return `${accountId}:${guildId}:${channelId}`;
	}
}
