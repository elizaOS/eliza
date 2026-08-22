/**
 * Unit tests for `VoiceManager` — voice-channel join/leave and audio routing,
 * against a mocked runtime and Discord voice stack (no real gateway).
 */
import { EventEmitter } from "node:events";
import { PassThrough, Transform } from "node:stream";
import type { UUID } from "@elizaos/core";
import { ChannelType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ICompatRuntime } from "../compat";
import { VoiceManager } from "../voice";

const voiceModule = vi.hoisted(() => ({
	entersState: vi.fn(),
	joinVoiceChannel: vi.fn(),
}));

vi.mock("@discordjs/voice", () => ({
	createAudioPlayer: vi.fn(),
	createAudioResource: vi.fn(),
	entersState: voiceModule.entersState,
	getVoiceConnections: vi.fn(),
	joinVoiceChannel: voiceModule.joinVoiceChannel,
	NoSubscriberBehavior: { Pause: "pause" },
	StreamType: { OggOpus: "ogg/opus" },
	VoiceConnectionStatus: {
		Connecting: "connecting",
		Destroyed: "destroyed",
		Disconnected: "disconnected",
		Ready: "ready",
		Signalling: "signalling",
	},
}));

vi.mock("prism-media", () => ({
	default: {
		opus: {
			Decoder: class Decoder extends Transform {
				override _transform(
					chunk: Buffer,
					_encoding: BufferEncoding,
					callback: (error?: Error | null) => void,
				) {
					this.push(chunk);
					callback();
				}
			},
		},
	},
}));

function makeRuntime() {
	return {
		agentId: "00000000-0000-4000-8000-000000000002",
		getSetting: vi.fn(() => undefined),
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		},
	};
}

function makeConnection(receiveStream = new PassThrough()) {
	const speaking = new EventEmitter();
	return {
		destroy: vi.fn(),
		joinConfig: { channelId: "voice-1", guildId: "guild-1" },
		on: vi.fn(),
		receiver: {
			speaking,
			subscribe: vi.fn(() => receiveStream),
		},
		state: { status: "ready" },
	};
}

function makeChannel(member?: unknown) {
	const members = new Map<string, unknown>();
	if (member) members.set("user-1", member);
	return {
		guildId: "guild-1",
		id: "voice-1",
		name: "Owners Room",
		members,
		type: ChannelType.GuildVoice,
		guild: {
			id: "guild-1",
			members: { fetch: vi.fn() },
			voiceAdapterCreator: vi.fn(),
		},
	};
}

describe("VoiceManager", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("uses the Discord entity resolver for live voice speaker attribution", () => {
		const resolvedEntityId = "00000000-0000-4000-8000-000000000001" as UUID;
		const resolveDiscordEntityId = vi.fn(() => resolvedEntityId);
		const runtime = makeRuntime();

		const manager = new VoiceManager(
			{
				accountId: "test",
				client: null,
				resolveDiscordEntityId,
			},
			runtime as unknown as ICompatRuntime,
		);

		expect(
			(
				manager as unknown as {
					resolveVoiceSpeakerEntityId(discordUserId: string): UUID;
				}
			).resolveVoiceSpeakerEntityId("1234567890"),
		).toBe(resolvedEntityId);
		expect(resolveDiscordEntityId).toHaveBeenCalledWith("1234567890");
	});

	it("rejects a text channel instead of reporting a successful join", async () => {
		const manager = new VoiceManager(
			{ accountId: "test", client: null },
			makeRuntime() as unknown as ICompatRuntime,
		);
		const editReply = vi.fn(async () => undefined);
		const textChannel = {
			id: "text-1",
			name: "general",
			type: ChannelType.GuildText,
		};

		await manager.handleJoinChannelCommand({
			deferReply: vi.fn(async () => undefined),
			editReply,
			guild: {
				channels: {
					cache: {
						find: (predicate: (channel: typeof textChannel) => boolean) =>
							predicate(textChannel) ? textChannel : undefined,
					},
				},
			} as never,
			options: { get: vi.fn(() => ({ value: textChannel.id })) },
		});

		expect(editReply).toHaveBeenCalledWith("Voice channel not found!");
		expect(voiceModule.joinVoiceChannel).not.toHaveBeenCalled();
	});

	it("fails the join when the Discord connection never becomes ready", async () => {
		const connection = makeConnection();
		voiceModule.joinVoiceChannel.mockReturnValue(connection);
		voiceModule.entersState.mockRejectedValue(new Error("not ready"));
		const manager = new VoiceManager(
			{ accountId: "test", client: new EventEmitter() as never },
			makeRuntime() as unknown as ICompatRuntime,
		);

		await expect(manager.joinChannel(makeChannel() as never)).rejects.toThrow(
			"not ready",
		);
		expect(connection.destroy).toHaveBeenCalledOnce();
	});

	it("subscribes to a newly-speaking member even before audio is buffered", async () => {
		const receiveStream = new PassThrough();
		expect(receiveStream.readableLength).toBe(0);
		const connection = makeConnection(receiveStream);
		voiceModule.joinVoiceChannel.mockReturnValue(connection);
		voiceModule.entersState.mockResolvedValue(connection);

		const client = new EventEmitter() as EventEmitter & {
			user?: { id: string };
		};
		client.user = { id: "bot-1" };
		const userStream = vi.fn();
		client.on("userStream", userStream);
		const member = {
			displayName: "Owner",
			guild: { id: "guild-1" },
			id: "user-1",
			user: { bot: false, displayName: "Owner", username: "owner" },
		};
		const channel = makeChannel(member);
		const manager = new VoiceManager(
			{ accountId: "test", client: client as never },
			makeRuntime() as unknown as ICompatRuntime,
		);

		await manager.joinChannel(channel as never);
		connection.receiver.speaking.emit("start", "user-1");

		await vi.waitFor(() => {
			expect(connection.receiver.subscribe).toHaveBeenCalledWith("user-1", {
				autoDestroy: true,
				emitClose: true,
			});
			expect(userStream).toHaveBeenCalledWith(
				"user-1",
				"Owner",
				"owner",
				channel,
				expect.any(Transform),
			);
		});
	});

	it("wires speaking start/end once when two joins share a connection", async () => {
		const connection = makeConnection();
		voiceModule.joinVoiceChannel.mockReturnValue(connection);
		voiceModule.entersState.mockResolvedValue(connection);
		const manager = new VoiceManager(
			{ accountId: "test", client: new EventEmitter() as never },
			makeRuntime() as unknown as ICompatRuntime,
		);
		const channel = makeChannel();

		await Promise.all([
			manager.joinChannel(channel as never),
			manager.joinChannel(channel as never),
		]);

		expect(connection.receiver.speaking.listenerCount("start")).toBe(1);
		expect(connection.receiver.speaking.listenerCount("end")).toBe(1);
	});

	it("does not resubscribe a member on a second speaking start", async () => {
		const receiveStream = new PassThrough();
		const connection = makeConnection(receiveStream);
		voiceModule.joinVoiceChannel.mockReturnValue(connection);
		voiceModule.entersState.mockResolvedValue(connection);

		const client = new EventEmitter() as EventEmitter & {
			user?: { id: string };
		};
		client.user = { id: "bot-1" };
		const member = {
			displayName: "Owner",
			guild: { id: "guild-1" },
			id: "user-1",
			user: { bot: false, displayName: "Owner", username: "owner" },
		};
		const channel = makeChannel(member);
		const manager = new VoiceManager(
			{ accountId: "test", client: client as never },
			makeRuntime() as unknown as ICompatRuntime,
		);

		await manager.joinChannel(channel as never);
		connection.receiver.speaking.emit("start", "user-1");
		await vi.waitFor(() => {
			expect(connection.receiver.subscribe).toHaveBeenCalledTimes(1);
		});

		connection.receiver.speaking.emit("start", "user-1");
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));

		expect(connection.receiver.subscribe).toHaveBeenCalledTimes(1);
	});
});
