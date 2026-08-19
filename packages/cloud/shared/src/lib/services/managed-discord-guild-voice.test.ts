/**
 * Covers managed Discord text and voice turns at their real connector boundary.
 * External identity, speech, and Durable Object collaborators are deterministic seams.
 */

import { describe, expect, mock, test } from "bun:test";

const sharedRestMessageSend = mock(async () => ({ text: "Shared reply" }));
const getByDiscordId = mock(async () => ({ id: "account-1" }));
const speechToText = mock(async () => "remind me in 1 minute: QA20315-DISCORD-DM-R3 verified");
const textToSpeech = mock(
  async () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    }),
);

mock.module("./shared-runtime/shared-rest-adapter", () => ({ sharedRestMessageSend }));
mock.module("./shared-runtime/personal-shared-agent", () => ({
  personalSharedAgent: () => ({ id: "personal-agent-1", agent_name: "Eliza" }),
  personalSharedDiscordGuildRoomId: () => "discord-room-1",
}));
mock.module("./eliza-app", () => ({ elizaAppUserService: { getByDiscordId } }));
mock.module("./managed-discord-guild-voice-policy", () => ({
  evaluateManagedDiscordGuildVoiceOwner: () => ({
    allowed: true,
    userId: "user-1",
    organizationId: "org-1",
  }),
}));
mock.module("./elevenlabs", () => ({
  ElevenLabsService: {
    fromEnv: () => ({ speechToText, textToSpeech }),
  },
}));

const { runManagedDiscordGuildTextTurn, runManagedDiscordGuildVoiceTurn } = await import(
  "./managed-discord-guild-voice"
);

function canonicalWavBase64(): string {
  const wav = Buffer.alloc(44);
  wav.write("RIFF", 0, "ascii");
  wav.write("WAVE", 8, "ascii");
  return wav.toString("base64");
}

describe("managed Discord Shared connector boundary", () => {
  test("keeps the text privacy wrapper for the model and sends raw capability text separately", async () => {
    const message = "remind me in 1 minute: QA20315-DISCORD-DM-R3 verified";
    await runManagedDiscordGuildTextTurn(
      {
        discordUserId: "discord-1",
        discordUsername: "alice",
        displayName: "Alice",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
        message,
        userId: "user-1",
        organizationId: "org-1",
      },
      { namespace: {} as never, executionCtx: {} as never },
    );

    expect(sharedRestMessageSend).toHaveBeenCalledTimes(1);
    const call = sharedRestMessageSend.mock.calls[0];
    expect(call?.[2]).toContain("[Public Discord guild channel; speaker: Alice.");
    expect(call?.[2]).toContain(message);
    expect(call?.[9]).toBe(message);
    expect(call?.[10]).toEqual({ type: "GROUP", source: "discord" });
  });

  test("keeps the voice privacy wrapper for the model and sends raw transcript separately", async () => {
    const transcript = "remind me in 1 minute: QA20315-DISCORD-DM-R3 verified";
    await runManagedDiscordGuildVoiceTurn(
      {
        discordUserId: "discord-1",
        discordUsername: "alice",
        displayName: "Alice",
        guildId: "guild-1",
        channelId: "channel-1",
        utteranceId: "utterance-1",
        wavBase64: canonicalWavBase64(),
      },
      { namespace: {} as never, executionCtx: {} as never, elevenLabsEnv: {} as never },
    );

    expect(sharedRestMessageSend).toHaveBeenCalledTimes(2);
    const call = sharedRestMessageSend.mock.calls[1];
    expect(call?.[2]).toContain("[Public Discord guild voice; speaker: Alice.");
    expect(call?.[2]).toContain(transcript);
    expect(call?.[9]).toBe(transcript);
    expect(call?.[10]).toEqual({ type: "VOICE_GROUP", source: "discord" });
    expect(textToSpeech).toHaveBeenCalledWith({
      text: "Shared reply",
      outputFormat: "mp3_44100_128",
    });
  });
});
