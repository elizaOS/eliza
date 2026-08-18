/**
 * Authorizes and executes managed Discord guild text and voice turns against
 * personal Shared Eliza while isolating public guild history from private transports.
 */
import { ChannelType } from "@elizaos/core/edge";
import { ElevenLabsService } from "./elevenlabs";
import { elizaAppUserService } from "./eliza-app";
import {
  evaluateManagedDiscordGuildVoiceOwner,
  type ManagedDiscordGuildVoiceIdentity,
} from "./managed-discord-guild-voice-policy";
import {
  personalSharedAgent,
  personalSharedDiscordGuildRoomId,
} from "./shared-runtime/personal-shared-agent";
import { sharedRestMessageSend } from "./shared-runtime/shared-rest-adapter";

const MAX_GUILD_VOICE_WAV_BYTES = 8 * 1024 * 1024;

interface GuildVoiceRuntimeContext {
  namespace: Parameters<typeof sharedRestMessageSend>[5];
  executionCtx: Parameters<typeof sharedRestMessageSend>[4];
  elevenLabsEnv: Parameters<typeof ElevenLabsService.fromEnv>[0];
}

interface GuildTextRuntimeContext {
  namespace: Parameters<typeof sharedRestMessageSend>[5];
  executionCtx: Parameters<typeof sharedRestMessageSend>[4];
}

export async function authorizeManagedDiscordGuildVoice(
  discordUserId: string,
): Promise<ManagedDiscordGuildVoiceIdentity> {
  const account = await elizaAppUserService.getByDiscordId(discordUserId);
  return evaluateManagedDiscordGuildVoiceOwner(account);
}

/** Execute one owner-authorized public guild text turn in an isolated room. */
export async function runManagedDiscordGuildTextTurn(
  input: {
    discordUserId: string;
    discordUsername: string;
    displayName?: string;
    guildId: string;
    channelId: string;
    messageId: string;
    message: string;
    userId: string;
    organizationId: string;
  },
  context: GuildTextRuntimeContext,
): Promise<{
  replyText: string;
  agentId: string;
  roomId: string;
  userId: string;
  organizationId: string;
}> {
  const agent = personalSharedAgent({
    userId: input.userId,
    organizationId: input.organizationId,
  });
  const roomId = personalSharedDiscordGuildRoomId({
    agentId: agent.id,
    discordUserId: input.discordUserId,
    guildId: input.guildId,
    channelId: input.channelId,
  });
  const speaker = (input.displayName ?? input.discordUsername)
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 80);
  const publicTurn = [
    `[Public Discord guild channel; speaker: ${speaker}.`,
    "Use only this public guild channel's context. Never reveal or summarize context from any private transport.]",
    input.message,
  ].join("\n");
  const reply = await sharedRestMessageSend(
    agent,
    roomId,
    publicTurn,
    agent.agent_name ?? "Eliza",
    context.executionCtx,
    context.namespace,
    `discord-guild:${input.messageId}`,
    "platform",
    undefined,
    input.message,
    { source: "discord", channelType: ChannelType.GROUP },
  );
  return {
    replyText: reply.text.trim(),
    agentId: agent.id,
    roomId,
    userId: input.userId,
    organizationId: input.organizationId,
  };
}

function decodeCanonicalWav(wavBase64: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(wavBase64)) {
    throw new Error("Discord guild voice audio is not canonical base64");
  }
  const bytes = Buffer.from(wavBase64, "base64");
  if (
    bytes.byteLength < 44 ||
    bytes.byteLength > MAX_GUILD_VOICE_WAV_BYTES ||
    bytes.toString("base64") !== wavBase64 ||
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.subarray(8, 12).toString("ascii") !== "WAVE"
  ) {
    throw new Error("Discord guild voice audio is not a bounded WAV stream");
  }
  return bytes;
}

async function collectAudio(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    length += result.value.byteLength;
    if (length > MAX_GUILD_VOICE_WAV_BYTES) {
      await reader.cancel("Discord guild voice TTS exceeded the response limit");
      throw new Error("Discord guild voice TTS exceeded the response limit");
    }
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function runManagedDiscordGuildVoiceTurn(
  input: {
    discordUserId: string;
    discordUsername: string;
    displayName?: string;
    guildId: string;
    channelId: string;
    utteranceId: string;
    wavBase64: string;
  },
  context: GuildVoiceRuntimeContext,
): Promise<{
  transcript: string;
  replyText: string;
  audioBase64: string;
  audioContentType: "audio/mpeg";
}> {
  const identity = await authorizeManagedDiscordGuildVoice(input.discordUserId);
  if (!identity.allowed || !identity.userId || !identity.organizationId) {
    throw new Error("Discord guild voice owner authorization failed");
  }
  const wav = decodeCanonicalWav(input.wavBase64);
  const audio = new ArrayBuffer(wav.byteLength);
  new Uint8Array(audio).set(wav);
  const speech = ElevenLabsService.fromEnv(context.elevenLabsEnv);
  const transcript = (
    await speech.speechToText({
      audioFile: new File([audio], `${input.utteranceId}.wav`, { type: "audio/wav" }),
    })
  ).trim();
  if (!transcript) throw new Error("Discord guild voice contained no speech");

  const agent = personalSharedAgent({
    userId: identity.userId,
    organizationId: identity.organizationId,
  });
  const roomId = personalSharedDiscordGuildRoomId({
    agentId: agent.id,
    discordUserId: input.discordUserId,
    guildId: input.guildId,
    channelId: input.channelId,
  });
  const publicTurn = [
    `[Public Discord guild voice; speaker: ${input.displayName ?? input.discordUsername}.`,
    "Use only this guild-voice room's context. Never reveal or summarize context from any private transport.]",
    transcript,
  ].join("\n");
  const reply = await sharedRestMessageSend(
    agent,
    roomId,
    publicTurn,
    agent.agent_name ?? "Eliza",
    context.executionCtx,
    context.namespace,
    input.utteranceId,
    "platform",
    undefined,
    transcript,
    { source: "discord", channelType: ChannelType.VOICE_GROUP },
  );
  const replyText = reply.text.trim();
  if (!replyText) throw new Error("Shared Eliza returned no guild voice reply");
  const synthesized = await speech.textToSpeech({
    text: replyText,
    outputFormat: "mp3_44100_128",
  });
  const audioBytes = await collectAudio(synthesized);
  return {
    transcript,
    replyText,
    audioBase64: Buffer.from(audioBytes).toString("base64"),
    audioContentType: "audio/mpeg",
  };
}
