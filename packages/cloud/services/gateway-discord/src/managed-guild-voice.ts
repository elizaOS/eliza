/**
 * Runs consent-bound live guild audio for the single managed Eliza Discord bot.
 * The gateway owns Discord voice sockets while the authenticated Cloud API owns
 * canonical identity, authorization, memory isolation, transcription, and TTS.
 */
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  type AudioReceiveStream,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  type VoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  type ChatInputCommandInteraction,
  type Client,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  PermissionFlagsBits,
} from "discord.js";
import prism from "prism-media";
import { logger } from "./logger";

const WAV_HEADER_BYTES = 44;
const MAX_WAV_BYTES = 8 * 1024 * 1024;
const MAX_UTTERANCE_PCM_BYTES = MAX_WAV_BYTES - WAV_HEADER_BYTES;
const VOICE_READY_TIMEOUT_MS = 20_000;
const PLAYBACK_TIMEOUT_MS = 60_000;
const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

export const MANAGED_GUILD_VOICE_INTENT = GatewayIntentBits.GuildVoiceStates;

export const MANAGED_VOICE_COMMAND = {
  name: "voice",
  description: "Join or leave your current voice channel",
  type: ApplicationCommandType.ChatInput,
  integrationTypes: [ApplicationIntegrationType.GuildInstall],
  contexts: [InteractionContextType.Guild],
  defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
  options: [
    {
      name: "join",
      description: "Join your current voice channel",
      type: ApplicationCommandOptionType.Subcommand,
    },
    {
      name: "leave",
      description: "Leave your voice channel",
      type: ApplicationCommandOptionType.Subcommand,
    },
  ],
} as const;

interface ManagedVoiceAuthorization {
  allowed: boolean;
  userId?: string;
  organizationId?: string;
  reason?: string;
}

interface ManagedVoiceTurn {
  transcript: string;
  replyText: string;
  audioBase64: string;
  audioContentType: string;
}

export interface ManagedGuildVoiceCloudBridge {
  authorize(input: {
    discordUserId: string;
    guildId: string;
  }): Promise<ManagedVoiceAuthorization>;
  turn(input: {
    discordUserId: string;
    discordUsername: string;
    displayName?: string;
    guildId: string;
    channelId: string;
    utteranceId: string;
    wavBase64: string;
  }): Promise<ManagedVoiceTurn>;
}

interface ManagedVoiceSession {
  guildId: string;
  channelId: string;
  ownerDiscordUserId: string;
  connection: VoiceConnection;
  activeReceivers: Map<string, AudioReceiveStream>;
  turnChain: Promise<void>;
}

interface ManagedGuildVoiceControllerOptions {
  client: Client;
  bridge: ManagedGuildVoiceCloudBridge;
  join?: typeof joinVoiceChannel;
  waitForReady?: typeof entersState;
  decode?: (stream: AudioReceiveStream) => Readable;
  play?: (connection: VoiceConnection, audio: Buffer) => Promise<void>;
}

/** Convert signed 16-bit mono PCM into the WAV accepted by the Cloud bridge. */
export function pcmToWav(pcm: Buffer): Buffer {
  const byteRate = (SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8;
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Authenticated Cloud bridge; token values never enter errors or logs. */
export function createManagedGuildVoiceCloudBridge(input: {
  apiBaseUrl: string;
  getAuthorizationHeader: () => Record<string, string>;
  fetchImpl?: typeof fetch;
}): ManagedGuildVoiceCloudBridge {
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = `${input.apiBaseUrl.replace(/\/+$/, "")}/api/internal/discord/eliza-app/voice`;

  const post = async <T>(body: Record<string, unknown>): Promise<T> => {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...input.getAuthorizationHeader(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(`Managed guild voice bridge failed (${response.status})`);
    }
    return payload;
  };

  return {
    authorize: (request) => post({ action: "authorize", ...request }),
    turn: (request) => post({ action: "turn", ...request }),
  };
}

export class ManagedGuildVoiceController {
  private readonly client: Client;
  private readonly bridge: ManagedGuildVoiceCloudBridge;
  private readonly join: typeof joinVoiceChannel;
  private readonly waitForReady: typeof entersState;
  private readonly decode: (stream: AudioReceiveStream) => Readable;
  private readonly play: (
    connection: VoiceConnection,
    audio: Buffer,
  ) => Promise<void>;
  private readonly sessions = new Map<string, ManagedVoiceSession>();
  private started = false;

  constructor(options: ManagedGuildVoiceControllerOptions) {
    this.client = options.client;
    this.bridge = options.bridge;
    this.join = options.join ?? joinVoiceChannel;
    this.waitForReady = options.waitForReady ?? entersState;
    this.decode =
      options.decode ??
      ((stream) => {
        const decoder = new prism.opus.Decoder({
          rate: SAMPLE_RATE,
          channels: CHANNELS,
          frameSize: 960,
        });
        stream.pipe(decoder);
        return decoder;
      });
    this.play = options.play ?? playDiscordAudio;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.client.on(Events.InteractionCreate, this.handleInteraction);
    await this.registerCommand();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.client.off(Events.InteractionCreate, this.handleInteraction);
    for (const session of this.sessions.values()) this.destroySession(session);
    this.sessions.clear();
  }

  private async registerCommand(): Promise<void> {
    const application = this.client.application;
    if (!application) throw new Error("Discord application is unavailable");
    const commands = await application.commands.fetch();
    const existing = commands.find(
      (command) => command.name === MANAGED_VOICE_COMMAND.name,
    );
    if (existing) {
      await application.commands.edit(existing.id, MANAGED_VOICE_COMMAND);
    } else {
      await application.commands.create(MANAGED_VOICE_COMMAND);
    }
  }

  private readonly handleInteraction = async (
    interaction: unknown,
  ): Promise<void> => {
    const command = interaction as ChatInputCommandInteraction;
    if (!command.isChatInputCommand?.() || command.commandName !== "voice")
      return;
    try {
      await this.dispatchCommand(command);
    } catch (error) {
      logger.error("Managed guild voice command failed", {
        guildId: command.guildId,
        discordUserId: command.user.id,
        error: error instanceof Error ? error.message : String(error),
      });
      const payload = {
        content: "Voice is temporarily unavailable.",
        ephemeral: true,
      };
      if (command.deferred || command.replied)
        await command.editReply(payload.content);
      else await command.reply(payload);
    }
  };

  private async dispatchCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({
        content: "Voice controls are server-only.",
        ephemeral: true,
      });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "Manage Server permission is required.",
        ephemeral: true,
      });
      return;
    }

    const authorization = await this.bridge.authorize({
      discordUserId: interaction.user.id,
      guildId: interaction.guildId,
    });
    if (!authorization.allowed) {
      await interaction.reply({
        content:
          "Only the canonical owner of this Eliza account can control voice.",
        ephemeral: true,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand(true);
    if (subcommand === "leave") {
      const session = this.sessions.get(interaction.guildId);
      if (!session || session.ownerDiscordUserId !== interaction.user.id) {
        await interaction.reply({
          content: "I am not in your voice session.",
          ephemeral: true,
        });
        return;
      }
      this.destroySession(session);
      this.sessions.delete(interaction.guildId);
      await interaction.reply({
        content: "Left your voice channel.",
        ephemeral: true,
      });
      return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const channel = member.voice.channel;
    if (!channel?.isVoiceBased() || channel.guild.id !== interaction.guildId) {
      await interaction.reply({
        content:
          "Join a voice channel in this server first, then run `/voice join`.",
        ephemeral: true,
      });
      return;
    }
    const botMember = interaction.guild.members.me;
    const permissions = botMember ? channel.permissionsFor(botMember) : null;
    if (
      !permissions?.has(PermissionFlagsBits.Connect) ||
      !permissions.has(PermissionFlagsBits.Speak)
    ) {
      await interaction.reply({
        content:
          "I need View Channel, Connect, and Speak permissions in your voice channel.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const prior = this.sessions.get(interaction.guildId);
    if (prior) this.destroySession(prior);
    const connection = this.join({
      channelId: channel.id,
      guildId: interaction.guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      group: this.client.user?.id ?? "managed-eliza",
    });
    await this.waitForReady(
      connection,
      VoiceConnectionStatus.Ready,
      VOICE_READY_TIMEOUT_MS,
    );
    const session: ManagedVoiceSession = {
      guildId: interaction.guildId,
      channelId: channel.id,
      ownerDiscordUserId: interaction.user.id,
      connection,
      activeReceivers: new Map(),
      turnChain: Promise.resolve(),
    };
    this.sessions.set(interaction.guildId, session);
    this.attachReceiver(session, interaction.user.username, member.displayName);
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      void this.recoverDisconnectedSession(session);
    });
    await interaction.editReply(
      `Joined **${channel.name}**. I only listen to the owner who invoked this session.`,
    );
  }

  private attachReceiver(
    session: ManagedVoiceSession,
    username: string,
    displayName: string,
  ): void {
    session.connection.receiver.speaking.on(
      "start",
      (discordUserId: string) => {
        if (
          discordUserId !== session.ownerDiscordUserId ||
          session.activeReceivers.has(discordUserId)
        )
          return;
        const receiveStream = session.connection.receiver.subscribe(
          discordUserId,
          {
            autoDestroy: true,
            emitClose: true,
            end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
          },
        );
        session.activeReceivers.set(discordUserId, receiveStream);
        // A fresh Discord receive subscription is expected to be empty here.
        // Attach the decoder immediately; checking readableLength would drop the
        // first utterance before Discord has delivered its first Opus packet.
        const decoder = this.decode(receiveStream);
        const chunks: Buffer[] = [];
        let size = 0;
        decoder.on("data", (chunk: Buffer) => {
          if (size >= MAX_UTTERANCE_PCM_BYTES) return;
          const accepted = chunk.subarray(0, MAX_UTTERANCE_PCM_BYTES - size);
          chunks.push(accepted);
          size += accepted.length;
        });
        decoder.once("end", () => {
          session.activeReceivers.delete(discordUserId);
          if (size === 0 || this.sessions.get(session.guildId) !== session)
            return;
          const wavBase64 = pcmToWav(Buffer.concat(chunks)).toString("base64");
          session.turnChain = session.turnChain
            .then(() =>
              this.processTurn(session, {
                discordUserId,
                discordUsername: username,
                displayName,
                wavBase64,
              }),
            )
            .catch((error) => {
              // error-policy:J7 a failed utterance is reported without killing the receiver loop.
              logger.error("Managed guild voice turn failed", {
                guildId: session.guildId,
                channelId: session.channelId,
                discordUserId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
        });
        decoder.once("error", (error) => {
          session.activeReceivers.delete(discordUserId);
          logger.warn("Managed guild voice decode failed", {
            guildId: session.guildId,
            discordUserId,
            error: error.message,
          });
        });
      },
    );
  }

  private async processTurn(
    session: ManagedVoiceSession,
    speaker: {
      discordUserId: string;
      discordUsername: string;
      displayName: string;
      wavBase64: string;
    },
  ): Promise<void> {
    const result = await this.bridge.turn({
      ...speaker,
      guildId: session.guildId,
      channelId: session.channelId,
      utteranceId: `discord-voice:${session.guildId}:${session.channelId}:${randomUUID()}`,
    });
    if (!result.audioBase64 || this.sessions.get(session.guildId) !== session)
      return;
    const audio = Buffer.from(result.audioBase64, "base64");
    await this.play(session.connection, audio);
  }

  private async recoverDisconnectedSession(
    session: ManagedVoiceSession,
  ): Promise<void> {
    if (this.sessions.get(session.guildId) !== session) return;
    try {
      await Promise.race([
        this.waitForReady(
          session.connection,
          VoiceConnectionStatus.Signalling,
          5_000,
        ),
        this.waitForReady(
          session.connection,
          VoiceConnectionStatus.Connecting,
          5_000,
        ),
      ]);
    } catch (error) {
      if (this.sessions.get(session.guildId) !== session) return;
      logger.warn("Managed guild voice reconnect failed; ending session", {
        guildId: session.guildId,
        channelId: session.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.sessions.delete(session.guildId);
      this.destroySession(session);
    }
  }

  private destroySession(session: ManagedVoiceSession): void {
    session.connection.receiver.speaking.removeAllListeners("start");
    for (const stream of session.activeReceivers.values()) stream.destroy();
    session.activeReceivers.clear();
    try {
      session.connection.destroy();
    } catch (error) {
      // error-policy:J6 voice teardown is best-effort after session ownership is removed.
      logger.warn("Managed guild voice teardown failed", {
        guildId: session.guildId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function playDiscordAudio(
  connection: VoiceConnection,
  audio: Buffer,
): Promise<void> {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Stop },
  });
  const subscription = connection.subscribe(player);
  if (!subscription)
    throw new Error("Discord voice player subscription failed");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Discord voice playback timed out")),
      PLAYBACK_TIMEOUT_MS,
    );
    const settle = (callback: () => void) => {
      clearTimeout(timeout);
      player.removeAllListeners();
      callback();
    };
    player.once(AudioPlayerStatus.Idle, () => settle(resolve));
    player.once("error", (error) => settle(() => reject(error)));
    player.play(createAudioResource(Readable.from(audio)));
  });
  subscription.unsubscribe();
}
