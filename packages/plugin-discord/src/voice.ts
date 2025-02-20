import {
    type AudioPlayer,
    type AudioReceiveStream,
    NoSubscriberBehavior,
    StreamType,
    type VoiceConnection,
    VoiceConnectionStatus,
    createAudioPlayer,
    createAudioResource,
    entersState,
    getVoiceConnections,
    joinVoiceChannel,
} from "@discordjs/voice";
import {
    type Content,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type UUID,
    logger,
    stringToUuid,
    type ChannelType
} from "@elizaos/core";
import {
    type BaseGuildVoiceChannel,
    ChannelType as DiscordChannelType,
    type Client,
    type Guild,
    type GuildMember,
    type VoiceChannel,
    type VoiceState,
} from "discord.js";
import EventEmitter from "node:events";
import prism from "prism-media";
import { type Readable, pipeline } from "node:stream";
import type { DiscordClient } from "./index.ts";
import { getWavHeader } from "./utils.ts";

// These values are chosen for compatibility with picovoice components
const DECODE_FRAME_SIZE = 1024;
const DECODE_SAMPLE_RATE = 16000;

export class AudioMonitor {
    private readable: Readable;
    private buffers: Buffer[] = [];
    private maxSize: number;
    private lastFlagged = -1;
    private ended = false;

    constructor(
        readable: Readable,
        maxSize: number,
        onStart: () => void,
        callback: (buffer: Buffer) => void
    ) {
        this.readable = readable;
        this.maxSize = maxSize;
        this.readable.on("data", (chunk: Buffer) => {
            //console.log('AudioMonitor got data');
            if (this.lastFlagged < 0) {
                this.lastFlagged = this.buffers.length;
            }
            this.buffers.push(chunk);
            const currentSize = this.buffers.reduce(
                (acc, cur) => acc + cur.length,
                0
            );
            while (currentSize > this.maxSize) {
                this.buffers.shift();
                this.lastFlagged--;
            }
        });
        this.readable.on("end", () => {
            logger.log("AudioMonitor ended");
            this.ended = true;
            if (this.lastFlagged < 0) return;
            callback(this.getBufferFromStart());
            this.lastFlagged = -1;
        });
        this.readable.on("speakingStopped", () => {
            if (this.ended) return;
            logger.log("Speaking stopped");
            if (this.lastFlagged < 0) return;
            callback(this.getBufferFromStart());
        });
        this.readable.on("speakingStarted", () => {
            if (this.ended) return;
            onStart();
            logger.log("Speaking started");
            this.reset();
        });
    }

    stop() {
        this.readable.removeAllListeners("data");
        this.readable.removeAllListeners("end");
        this.readable.removeAllListeners("speakingStopped");
        this.readable.removeAllListeners("speakingStarted");
    }

    isFlagged() {
        return this.lastFlagged >= 0;
    }

    getBufferFromFlag() {
        if (this.lastFlagged < 0) {
            return null;
        }
        const buffer = Buffer.concat(this.buffers.slice(this.lastFlagged));
        return buffer;
    }

    getBufferFromStart() {
        const buffer = Buffer.concat(this.buffers);
        return buffer;
    }

    reset() {
        this.buffers = [];
        this.lastFlagged = -1;
    }

    isEnded() {
        return this.ended;
    }
}

export class VoiceManager extends EventEmitter {
    private processingVoice = false;
    private transcriptionTimeout: NodeJS.Timeout | null = null;
    private userStates: Map<
        string,
        {
            buffers: Buffer[];
            totalLength: number;
            lastActive: number;
            transcriptionText: string;
        }
    > = new Map();
    private activeAudioPlayer: AudioPlayer | null = null;
    private client: Client;
    private runtime: IAgentRuntime;
    private streams: Map<string, Readable> = new Map();
    private connections: Map<string, VoiceConnection> = new Map();
    private activeMonitors: Map<
        string,
        { channel: BaseGuildVoiceChannel; monitor: AudioMonitor }
    > = new Map();
    private ready: boolean;
    private getChannelType: (channelId: string) => Promise<ChannelType>;

    constructor(client: DiscordClient) {
        super();
        this.client = client.client;
        this.runtime = client.runtime;
        this.getChannelType = client.getChannelType;

        this.client.on("voiceManagerReady", () => {
            this.setReady(true);
        });
    }

    private setReady(status: boolean) {
        this.ready = status;
        this.emit("ready");
        logger.success(`VoiceManager is now ready: ${this.ready}`);
    }

    isReady() {
        return this.ready;
    }

    async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
        const oldChannelId = oldState.channelId;
        const newChannelId = newState.channelId;
        const member = newState.member;
        if (!member) return;
        if (member.id === this.client.user?.id) {
            return;
        }

        // Ignore mute/unmute events
        if (oldChannelId === newChannelId) {
            return;
        }

        // User leaving a channel where the bot is present
        if (oldChannelId && this.connections.has(oldChannelId)) {
            this.stopMonitoringMember(member.id);
        }

        // User joining a channel where the bot is present
        if (newChannelId && this.connections.has(newChannelId)) {
            await this.monitorMember(
                member,
                newState.channel as BaseGuildVoiceChannel
            );
        }
    }

    async joinChannel(channel: BaseGuildVoiceChannel) {
        const oldConnection = this.getVoiceConnection(
            channel.guildId as string
        );
        if (oldConnection) {
            try {
                oldConnection.destroy();
                // Remove all associated streams and monitors
                this.streams.clear();
                this.activeMonitors.clear();
            } catch (error) {
                console.error("Error leaving voice channel:", error);
            }
        }

        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator as any,
            selfDeaf: false,
            selfMute: false,
            group: this.client.user.id,
        });

        try {
            // Wait for either Ready or Signalling state
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Ready, 20_000),
                entersState(
                    connection,
                    VoiceConnectionStatus.Signalling,
                    20_000
                ),
            ]);

            // Log connection success
            logger.log(
                `Voice connection established in state: ${connection.state.status}`
            );

            // Set up ongoing state change monitoring
            connection.on("stateChange", async (oldState, newState) => {
                logger.log(
                    `Voice connection state changed from ${oldState.status} to ${newState.status}`
                );

                if (newState.status === VoiceConnectionStatus.Disconnected) {
                    logger.log("Handling disconnection...");

                    try {
                        // Try to reconnect if disconnected
                        await Promise.race([
                            entersState(
                                connection,
                                VoiceConnectionStatus.Signalling,
                                5_000
                            ),
                            entersState(
                                connection,
                                VoiceConnectionStatus.Connecting,
                                5_000
                            ),
                        ]);
                        // Seems to be reconnecting to a new channel
                        logger.log("Reconnecting to channel...");
                    } catch (e) {
                        // Seems to be a real disconnect, destroy and cleanup
                        logger.log(
                            `Disconnection confirmed - cleaning up...${e}`
                        );
                        connection.destroy();
                        this.connections.delete(channel.id);
                    }
                } else if (
                    newState.status === VoiceConnectionStatus.Destroyed
                ) {
                    this.connections.delete(channel.id);
                } else if (
                    !this.connections.has(channel.id) &&
                    (newState.status === VoiceConnectionStatus.Ready ||
                        newState.status === VoiceConnectionStatus.Signalling)
                ) {
                    this.connections.set(channel.id, connection);
                }
            });

            connection.on("error", (error) => {
                logger.log("Voice connection error:", error);
                // Don't immediately destroy - let the state change handler deal with it
                logger.log(
                    "Connection error - will attempt to recover..."
                );
            });

            // Store the connection
            this.connections.set(channel.id, connection);

            // Continue with voice state modifications
            const me = channel.guild.members.me;
            if (me?.voice && me.permissions.has("DeafenMembers")) {
                try {
                    await me.voice.setDeaf(false);
                    await me.voice.setMute(false);
                } catch (error) {
                    logger.log("Failed to modify voice state:", error);
                    // Continue even if this fails
                }
            }

            connection.receiver.speaking.on("start", async (userId: string) => {
                let user = channel.members.get(userId);
                if (!user) {
                    try {
                        user = await channel.guild.members.fetch(userId);
                    } catch (error) {
                        console.error("Failed to fetch user:", error);
                    }
                }
                if (user && !user?.user.bot) {
                    this.monitorMember(user as GuildMember, channel);
                    this.streams.get(userId)?.emit("speakingStarted");
                }
            });

            connection.receiver.speaking.on("end", async (userId: string) => {
                const user = channel.members.get(userId);
                if (!user?.user.bot) {
                    this.streams.get(userId)?.emit("speakingStopped");
                }
            });
        } catch (error) {
            logger.log("Failed to establish voice connection:", error);
            connection.destroy();
            this.connections.delete(channel.id);
            throw error;
        }
    }

    getVoiceConnection(guildId: string) {
        const connections = getVoiceConnections(this.client.user.id);
        if (!connections) {
            return;
        }
        const connection = [...connections.values()].find(
            (connection) => connection.joinConfig.guildId === guildId
        );
        return connection;
    }

    private async monitorMember(
        member: GuildMember,
        channel: BaseGuildVoiceChannel
    ) {
        const userId = member?.id;
        const userName = member?.user?.username;
        const name = member?.user?.displayName;
        const connection = this.getVoiceConnection(member?.guild?.id);
        const receiveStream = connection?.receiver.subscribe(userId, {
            autoDestroy: true,
            emitClose: true,
        });
        if (!receiveStream || receiveStream.readableLength === 0) {
            return;
        }
        const opusDecoder = new prism.opus.Decoder({
            channels: 1,
            rate: DECODE_SAMPLE_RATE,
            frameSize: DECODE_FRAME_SIZE,
        });
        const volumeBuffer: number[] = [];
        const VOLUME_WINDOW_SIZE = 30;
        const SPEAKING_THRESHOLD = 0.05;
        opusDecoder.on("data", (pcmData: Buffer) => {
            // Monitor the audio volume while the agent is speaking.
            // If the average volume of the user's audio exceeds the defined threshold, it indicates active speaking.
            // When active speaking is detected, stop the agent's current audio playback to avoid overlap.

            if (this.activeAudioPlayer) {
                const samples = new Int16Array(
                    pcmData.buffer,
                    pcmData.byteOffset,
                    pcmData.length / 2
                );
                const maxAmplitude = Math.max(...samples.map(Math.abs)) / 32768;
                volumeBuffer.push(maxAmplitude);

                if (volumeBuffer.length > VOLUME_WINDOW_SIZE) {
                    volumeBuffer.shift();
                }
                const avgVolume =
                    volumeBuffer.reduce((sum, v) => sum + v, 0) /
                    VOLUME_WINDOW_SIZE;

                if (avgVolume > SPEAKING_THRESHOLD) {
                    volumeBuffer.length = 0;
                    this.cleanupAudioPlayer(this.activeAudioPlayer);
                    this.processingVoice = false;
                }
            }
        });
        pipeline(
            receiveStream as AudioReceiveStream,
            opusDecoder as any,
            (err: Error | null) => {
                if (err) {
                    console.log(`Opus decoding pipeline error: ${err}`);
                }
            }
        );
        this.streams.set(userId, opusDecoder);
        this.connections.set(userId, connection as VoiceConnection);
        opusDecoder.on("error", (err: any) => {
            console.log(`Opus decoding error: ${err}`);
        });
        const errorHandler = (err: any) => {
            console.log(`Opus decoding error: ${err}`);
        };
        const streamCloseHandler = () => {
            console.log(`voice stream from ${member?.displayName} closed`);
            this.streams.delete(userId);
            this.connections.delete(userId);
        };
        const closeHandler = () => {
            console.log(`Opus decoder for ${member?.displayName} closed`);
            opusDecoder.removeListener("error", errorHandler);
            opusDecoder.removeListener("close", closeHandler);
            receiveStream?.removeListener("close", streamCloseHandler);
        };
        opusDecoder.on("error", errorHandler);
        opusDecoder.on("close", closeHandler);
        receiveStream?.on("close", streamCloseHandler);

        this.client.emit(
            "userStream",
            userId,
            name,
            userName,
            channel,
            opusDecoder
        );
    }

    leaveChannel(channel: BaseGuildVoiceChannel) {
        const connection = this.connections.get(channel.id);
        if (connection) {
            connection.destroy();
            this.connections.delete(channel.id);
        }

        // Stop monitoring all members in this channel
        for (const [memberId, monitorInfo] of this.activeMonitors) {
            if (
                monitorInfo.channel.id === channel.id &&
                memberId !== this.client.user?.id
            ) {
                this.stopMonitoringMember(memberId);
            }
        }

        console.log(`Left voice channel: ${channel.name} (${channel.id})`);
    }

    stopMonitoringMember(memberId: string) {
        const monitorInfo = this.activeMonitors.get(memberId);
        if (monitorInfo) {
            monitorInfo.monitor.stop();
            this.activeMonitors.delete(memberId);
            this.streams.delete(memberId);
            console.log(`Stopped monitoring user ${memberId}`);
        }
    }

    async handleGuildCreate(guild: Guild) {
        console.log(`Joined guild ${guild.name}`);
        // this.scanGuild(guild);
    }

    async debouncedProcessTranscription(
        userId: UUID,
        name: string,
        userName: string,
        channel: BaseGuildVoiceChannel
    ) {
        const DEBOUNCE_TRANSCRIPTION_THRESHOLD = 1500; // wait for 1.5 seconds of silence

        if (this.activeAudioPlayer?.state?.status === "idle") {
            logger.log("Cleaning up idle audio player.");
            this.cleanupAudioPlayer(this.activeAudioPlayer);
        }

        if (this.activeAudioPlayer || this.processingVoice) {
            const state = this.userStates.get(userId);
            state.buffers.length = 0;
            state.totalLength = 0;
            return;
        }

        if (this.transcriptionTimeout) {
            clearTimeout(this.transcriptionTimeout);
        }

        this.transcriptionTimeout = setTimeout(async () => {
            this.processingVoice = true;
            try {
                await this.processTranscription(
                    userId,
                    channel.id,
                    channel,
                    name,
                    userName
                );

                // Clean all users' previous buffers
                this.userStates.forEach((state, _) => {
                    state.buffers.length = 0;
                    state.totalLength = 0;
                });
            } finally {
                this.processingVoice = false;
            }
        }, DEBOUNCE_TRANSCRIPTION_THRESHOLD) as unknown as NodeJS.Timeout;
    }

    async handleUserStream(
        userId: UUID,
        name: string,
        userName: string,
        channel: BaseGuildVoiceChannel,
        audioStream: Readable
    ) {
        console.log(`Starting audio monitor for user: ${userId}`);
        if (!this.userStates.has(userId)) {
            this.userStates.set(userId, {
                buffers: [],
                totalLength: 0,
                lastActive: Date.now(),
                transcriptionText: "",
            });
        }

        const state = this.userStates.get(userId);

        const processBuffer = async (buffer: Buffer) => {
            try {
                state?.buffers.push(buffer);
                state!.totalLength += buffer.length;
                state!.lastActive = Date.now();
                this.debouncedProcessTranscription(
                    userId,
                    name,
                    userName,
                    channel
                );
            } catch (error) {
                console.error(
                    `Error processing buffer for user ${userId}:`,
                    error
                );
            }
        };

        new AudioMonitor(
            audioStream,
            10000000,
            () => {
                if (this.transcriptionTimeout) {
                    clearTimeout(this.transcriptionTimeout);
                }
            },
            async (buffer) => {
                if (!buffer) {
                    console.error("Received empty buffer");
                    return;
                }
                await processBuffer(buffer);
            }
        );
    }

    private async processTranscription(
        userId: UUID,
        channelId: string,
        channel: BaseGuildVoiceChannel,
        name: string,
        userName: string
    ) {
        const state = this.userStates.get(userId);
        if (!state || state.buffers.length === 0) return;
        try {
            const inputBuffer = Buffer.concat(state.buffers, state.totalLength);

            state.buffers.length = 0; // Clear the buffers
            state.totalLength = 0;
            // Convert Opus to WAV
            const wavBuffer = await this.convertOpusToWav(inputBuffer);
            console.log("Starting transcription...");

            const transcriptionText = await this.runtime.useModel(ModelClass.TRANSCRIPTION, wavBuffer)
            function isValidTranscription(text: string): boolean {
                if (!text || text.includes("[BLANK_AUDIO]")) return false;
                return true;
            }

            if (transcriptionText && isValidTranscription(transcriptionText)) {
                state.transcriptionText += transcriptionText;
            }

            if (state.transcriptionText.length) {
                this.cleanupAudioPlayer(this.activeAudioPlayer);
                const finalText = state.transcriptionText;
                state.transcriptionText = "";
                await this.handleMessage(
                    finalText,
                    userId,
                    channelId,
                    channel,
                    name,
                    userName
                );
            }
        } catch (error) {
            console.error(
                `Error transcribing audio for user ${userId}:`,
                error
            );
        }
    }

    private async handleMessage(
        message: string,
        userId: UUID,
        channelId: string,
        channel: BaseGuildVoiceChannel,
        name: string,
        userName: string
    ) {
        try {
            if (!message || message.trim() === "" || message.length < 3) {
                return { text: "", action: "IGNORE" };
            }

            const roomId = stringToUuid(`${channelId}-${this.runtime.agentId}`);
            const userIdUUID = stringToUuid(userId);
            const guild = await channel.guild.fetch();
            const type = await this.getChannelType(guild.id);

            await this.runtime.ensureConnection({
                userId: userIdUUID,
                roomId,
                userName,
                userScreenName: name,
                source: "discord",
                channelId,
                serverId: channel.guild.id,
                type,
            });

            const memory: Memory = {
                id: stringToUuid(`${channelId}-voice-message-${Date.now()}`),
                agentId: this.runtime.agentId,
                userId: userIdUUID,
                roomId,
                content: {
                    text: message,
                    source: "discord",
                    url: channel.url,
                    name: name,
                    userName: userName,
                    isVoiceMessage: true
                },
                createdAt: Date.now(),
            };

            const callback: HandlerCallback = async (content: Content, _files: any[] = []) => {
                try {
                    const responseMemory: Memory = {
                        id: stringToUuid(`${memory.id}-voice-response-${Date.now()}`),
                        userId: this.runtime.agentId,
                        agentId: this.runtime.agentId,
                        content: {
                            ...content,
                            user: this.runtime.character.name,
                            inReplyTo: memory.id,
                            isVoiceMessage: true
                        },
                        roomId,
                        createdAt: Date.now(),
                    };

                    if (responseMemory.content.text?.trim()) {
                        await this.runtime.messageManager.createMemory(responseMemory);

                        const responseStream = await this.runtime.useModel(ModelClass.TEXT_TO_SPEECH, content.text);
                        if (responseStream) {
                            await this.playAudioStream(userId, responseStream as Readable);
                        }
                    }

                    return [responseMemory];
                } catch (error) {
                    console.error("Error in voice message callback:", error);
                    return [];
                }
            };

            // Emit voice-specific events
            this.runtime.emitEvent(["DISCORD_VOICE_MESSAGE_RECEIVED", "VOICE_MESSAGE_RECEIVED"], {
                runtime: this.runtime,
                message: memory,
                callback,
            });
        } catch (error) {
            console.error("Error processing voice message:", error);
        }
    }

    private async convertOpusToWav(pcmBuffer: Buffer): Promise<Buffer> {
        try {
            // Generate the WAV header
            const wavHeader = getWavHeader(
                pcmBuffer.length,
                DECODE_SAMPLE_RATE
            );

            // Concatenate the WAV header and PCM data
            const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);

            return wavBuffer;
        } catch (error) {
            console.error("Error converting PCM to WAV:", error);
            throw error;
        }
    }

    async scanGuild(guild: Guild) {
        let chosenChannel: BaseGuildVoiceChannel | null = null;

        try {
            const channelId = this.runtime.getSetting(
                "DISCORD_VOICE_CHANNEL_ID"
            ) as string;
            if (channelId) {
                const channel = await guild.channels.fetch(channelId);
                if (channel?.isVoiceBased()) {
                    chosenChannel = channel as BaseGuildVoiceChannel;
                }
            }

            if (!chosenChannel) {
                const channels = (await guild.channels.fetch()).filter(
                    (channel) => channel?.type === DiscordChannelType.GuildVoice
                );
                for (const [, channel] of channels) {
                    const voiceChannel = channel as BaseGuildVoiceChannel;
                    if (
                        voiceChannel.members.size > 0 &&
                        (chosenChannel === null ||
                            voiceChannel.members.size >
                                chosenChannel.members.size)
                    ) {
                        chosenChannel = voiceChannel;
                    }
                }
            }

            if (chosenChannel) {
                console.log(`Joining channel: ${chosenChannel.name}`);
                await this.joinChannel(chosenChannel);
            } else {
                console.warn("No suitable voice channel found to join.");
            }
        } catch (error) {
            console.error("Error selecting or joining a voice channel:", error);
        }
    }

    async playAudioStream(userId: UUID, audioStream: Readable) {
        const connection = this.connections.get(userId);
        if (connection == null) {
            console.log(`No connection for user ${userId}`);
            return;
        }
        this.cleanupAudioPlayer(this.activeAudioPlayer);
        const audioPlayer = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Pause,
            },
        });
        this.activeAudioPlayer = audioPlayer;
        connection.subscribe(audioPlayer);

        const audioStartTime = Date.now();

        const resource = createAudioResource(audioStream, {
            inputType: StreamType.Arbitrary,
        });
        audioPlayer.play(resource);

        audioPlayer.on("error", (err: any) => {
            console.log(`Audio player error: ${err}`);
        });

        audioPlayer.on(
            "stateChange",
            (_oldState: any, newState: { status: string }) => {
                if (newState.status === "idle") {
                    const idleTime = Date.now();
                    console.log(
                        `Audio playback took: ${idleTime - audioStartTime}ms`
                    );
                }
            }
        );
    }

    cleanupAudioPlayer(audioPlayer: AudioPlayer) {
        if (!audioPlayer) return;

        audioPlayer.stop();
        audioPlayer.removeAllListeners();
        if (audioPlayer === this.activeAudioPlayer) {
            this.activeAudioPlayer = null;
        }
    }

    async handleJoinChannelCommand(interaction: any) {
        try {
            // Defer the reply immediately to prevent interaction timeout
            await interaction.deferReply();

            const channelId = interaction.options.get("channel")
                ?.value as string;
            if (!channelId) {
                await interaction.editReply(
                    "Please provide a voice channel to join."
                );
                return;
            }

            const guild = interaction.guild;
            if (!guild) {
                await interaction.editReply("Could not find guild.");
                return;
            }

            const voiceChannel = interaction.guild.channels.cache.find(
                (channel: VoiceChannel) =>
                    channel.id === channelId &&
                    channel.type === DiscordChannelType.GuildVoice
            );

            if (!voiceChannel) {
                await interaction.editReply("Voice channel not found!");
                return;
            }

            await this.joinChannel(voiceChannel as BaseGuildVoiceChannel);
            await interaction.editReply(
                `Joined voice channel: ${voiceChannel.name}`
            );
        } catch (error) {
            console.error("Error joining voice channel:", error);
            // Use editReply instead of reply for the error case
            await interaction
                .editReply("Failed to join the voice channel.")
                .catch(console.error);
        }
    }

    async handleLeaveChannelCommand(interaction: any) {
        const connection = this.getVoiceConnection(interaction.guildId as any);

        if (!connection) {
            await interaction.reply("Not currently in a voice channel.");
            return;
        }

        try {
            connection.destroy();
            await interaction.reply("Left the voice channel.");
        } catch (error) {
            console.error("Error leaving voice channel:", error);
            await interaction.reply("Failed to leave the voice channel.");
        }
    }
}
