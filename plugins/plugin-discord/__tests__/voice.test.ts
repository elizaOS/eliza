import type { UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ICompatRuntime } from "../compat";
import { VoiceManager } from "../voice";

vi.mock("@discordjs/voice", () => ({
	createAudioPlayer: vi.fn(),
	createAudioResource: vi.fn(),
	entersState: vi.fn(),
	getVoiceConnections: vi.fn(),
	joinVoiceChannel: vi.fn(),
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

describe("VoiceManager", () => {
	it("uses the Discord entity resolver for live voice speaker attribution", () => {
		const resolvedEntityId = "00000000-0000-4000-8000-000000000001" as UUID;
		const resolveDiscordEntityId = vi.fn(() => resolvedEntityId);
		const runtime = {
			agentId: "00000000-0000-4000-8000-000000000002",
			logger: {
				error: vi.fn(),
			},
		};

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
});
