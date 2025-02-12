import {
    logger,
    stringToUuid,
    type TestSuite,
    type Character,
    type Client as ElizaClient,
    type IAgentRuntime,
    type Plugin
} from "@elizaos/core";
import {
    Client,
    Events,
    GatewayIntentBits,
    Partials,
    PermissionsBitField,
    type Guild,
    type MessageReaction,
    type User,
} from "discord.js";
import { EventEmitter } from "events";
import chat_with_attachments from "./actions/chat_with_attachments.ts";
import download_media from "./actions/download_media.ts";
import joinvoice from "./actions/joinvoice.ts";
import leavevoice from "./actions/leavevoice.ts";
import summarize from "./actions/summarize_conversation.ts";
import transcribe_media from "./actions/transcribe_media.ts";
import { MessageManager } from "./messages.ts";
import channelStateProvider from "./providers/channelState.ts";
import voiceStateProvider from "./providers/voiceState.ts";
import reply from "./actions/reply.ts";
import type { IDiscordClient } from "./types.ts";
import { VoiceManager } from "./voice.ts";

export class DiscordClient extends EventEmitter implements IDiscordClient {
    apiToken: string;
    client: Client;
    runtime: IAgentRuntime;
    character: Character;
    private messageManager: MessageManager;
    private voiceManager: VoiceManager;

    constructor(runtime: IAgentRuntime) {
        super();

        this.apiToken = runtime.getSetting("DISCORD_API_TOKEN") as string;
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.DirectMessages,
                GatewayIntentBits.GuildVoiceStates,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.DirectMessageTyping,
                GatewayIntentBits.GuildMessageTyping,
                GatewayIntentBits.GuildMessageReactions,
            ],
            partials: [
                Partials.Channel,
                Partials.Message,
                Partials.User,
                Partials.Reaction,
            ],
        });

        this.runtime = runtime;
        this.voiceManager = new VoiceManager(this);
        this.messageManager = new MessageManager(this, this.voiceManager);

        this.client.once(Events.ClientReady, this.onClientReady.bind(this));
        this.client.login(this.apiToken);

        this.setupEventListeners();
    }

    private setupEventListeners() {
        // When joining to a new server
        this.client.on("guildCreate", this.handleGuildCreate.bind(this));

        this.client.on(
            Events.MessageReactionAdd,
            this.handleReactionAdd.bind(this)
        );
        this.client.on(
            Events.MessageReactionRemove,
            this.handleReactionRemove.bind(this)
        );

        // Handle voice events with the voice manager
        this.client.on(
            "voiceStateUpdate",
            this.voiceManager.handleVoiceStateUpdate.bind(this.voiceManager)
        );
        this.client.on(
            "userStream",
            this.voiceManager.handleUserStream.bind(this.voiceManager)
        );

        // Handle a new message with the message manager
        this.client.on(
            Events.MessageCreate,
            this.messageManager.handleMessage.bind(this.messageManager)
        );

        // Handle a new interaction
        this.client.on(
            Events.InteractionCreate,
            this.handleInteractionCreate.bind(this)
        );
    }

    async stop() {
        try {
            // disconnect websocket
            // this unbinds all the listeners
            await this.client.destroy();
        } catch (e) {
            logger.error("client-discord instance stop err", e);
        }
    }

    private async onClientReady(readyClient: { user: { tag: any; id: any } }) {
        logger.success(`Logged in as ${readyClient.user?.tag}`);

        // Register slash commands
        const commands = [
            {
                name: "joinchannel",
                description: "Join a voice channel",
                options: [
                    {
                        name: "channel",
                        type: 7, // CHANNEL type
                        description: "The voice channel to join",
                        required: true,
                        channel_types: [2], // GuildVoice type
                    },
                ],
            },
            {
                name: "leavechannel",
                description: "Leave the current voice channel",
            },
        ];

        try {
            await this.client.application?.commands.set(commands);
            logger.success("Slash commands registered");
        } catch (error) {
            console.error("Error registering slash commands:", error);
        }

        // Required permissions for the bot
        const requiredPermissions = [
            // Text Permissions
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.SendMessagesInThreads,
            PermissionsBitField.Flags.CreatePrivateThreads,
            PermissionsBitField.Flags.CreatePublicThreads,
            PermissionsBitField.Flags.EmbedLinks,
            PermissionsBitField.Flags.AttachFiles,
            PermissionsBitField.Flags.AddReactions,
            PermissionsBitField.Flags.UseExternalEmojis,
            PermissionsBitField.Flags.UseExternalStickers,
            PermissionsBitField.Flags.MentionEveryone,
            PermissionsBitField.Flags.ManageMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            // Voice Permissions
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.Speak,
            PermissionsBitField.Flags.UseVAD,
            PermissionsBitField.Flags.PrioritySpeaker,
        ].reduce((a, b) => a | b, 0n);

        logger.success("Use this URL to add the bot to your server:");
        logger.success(
            `https://discord.com/api/oauth2/authorize?client_id=${readyClient.user?.id}&permissions=${requiredPermissions}&scope=bot%20applications.commands`
        );
        await this.onReady();
    }

    async handleReactionAdd(reaction: MessageReaction, user: User) {
        try {
            logger.log("Reaction added");

            // Early returns
            if (!reaction || !user) {
                logger.warn("Invalid reaction or user");
                return;
            }

            // Get emoji info
            let emoji = reaction.emoji.name;
            if (!emoji && reaction.emoji.id) {
                emoji = `<:${reaction.emoji.name}:${reaction.emoji.id}>`;
            }

            // Fetch full message if partial
            if (reaction.partial) {
                try {
                    await reaction.fetch();
                } catch (error) {
                    logger.error(
                        "Failed to fetch partial reaction:",
                        error
                    );
                    return;
                }
            }

            // Generate IDs with timestamp to ensure uniqueness
            const timestamp = Date.now();
            const roomId = stringToUuid(
                `${reaction.message.channel.id}-${this.runtime.agentId}`
            );
            const userIdUUID = stringToUuid(
                `${user.id}-${this.runtime.agentId}`
            );
            const reactionUUID = stringToUuid(
                `${reaction.message.id}-${user.id}-${emoji}-${timestamp}-${this.runtime.agentId}`
            );

            // Validate IDs
            if (!userIdUUID || !roomId) {
                logger.error("Invalid user ID or room ID", {
                    userIdUUID,
                    roomId,
                });
                return;
            }

            // Process message content
            const messageContent = reaction.message.content || "";
            const truncatedContent =
                messageContent.length > 100
                    ? `${messageContent.substring(0, 100)}...`
                    : messageContent;
            const reactionMessage = `*<${emoji}>: "${truncatedContent}"*`;

            // Get user info
            const userName = reaction.message.author?.username || "unknown";
            const name = reaction.message.author?.displayName || userName;

            // Ensure connection
            await this.runtime.ensureConnection(
                userIdUUID,
                roomId,
                userName,
                name,
                "discord"
            );

            // Create memory with retry logic
            const memory = {
                id: reactionUUID,
                userId: userIdUUID,
                agentId: this.runtime.agentId,
                content: {
                    text: reactionMessage,
                    source: "discord",
                    inReplyTo: stringToUuid(
                        `${reaction.message.id}-${this.runtime.agentId}`
                    ),
                },
                roomId,
                createdAt: timestamp,
            };

            try {
                await this.runtime.messageManager.createMemory(memory);
                logger.debug("Reaction memory created", {
                    reactionId: reactionUUID,
                    emoji,
                    userId: user.id,
                });
            } catch (error) {
                if (error.code === "23505") {
                    // Duplicate key error
                    logger.warn("Duplicate reaction memory, skipping", {
                        reactionId: reactionUUID,
                    });
                    return;
                }
                throw error; // Re-throw other errors
            }
        } catch (error) {
            logger.error("Error handling reaction:", error);
        }
    }

    async handleReactionRemove(reaction: MessageReaction, user: User) {
        logger.log("Reaction removed");
        // if (user.bot) return;

        let emoji = reaction.emoji.name;
        if (!emoji && reaction.emoji.id) {
            emoji = `<:${reaction.emoji.name}:${reaction.emoji.id}>`;
        }

        // Fetch the full message if it's a partial
        if (reaction.partial) {
            try {
                await reaction.fetch();
            } catch (error) {
                console.error(
                    "Something went wrong when fetching the message:",
                    error
                );
                return;
            }
        }

        const messageContent = reaction.message.content;
        const truncatedContent =
            messageContent.length > 50
                ? messageContent.substring(0, 50) + "..."
                : messageContent;

        const reactionMessage = `*Removed <${emoji} emoji> from: "${truncatedContent}"*`;

        const roomId = stringToUuid(
            reaction.message.channel.id + "-" + this.runtime.agentId
        );
        const userIdUUID = stringToUuid(user.id);

        // Generate a unique UUID for the reaction removal
        const reactionUUID = stringToUuid(
            `${reaction.message.id}-${user.id}-${emoji}-removed-${this.runtime.agentId}`
        );

        const userName = reaction.message.author.username;
        const name = reaction.message.author.displayName;

        await this.runtime.ensureConnection(
            userIdUUID,
            roomId,
            userName,
            name,
            "discord"
        );

        try {
            // Save the reaction removal as a message
            await this.runtime.messageManager.createMemory({
                id: reactionUUID, // This is the ID of the reaction removal message
                userId: userIdUUID,
                agentId: this.runtime.agentId,
                content: {
                    text: reactionMessage,
                    source: "discord",
                    inReplyTo: stringToUuid(
                        reaction.message.id + "-" + this.runtime.agentId
                    ), // This is the ID of the original message
                },
                roomId,
                createdAt: Date.now(),
            });
        } catch (error) {
            console.error("Error creating reaction removal message:", error);
        }
    }

    private handleGuildCreate(guild: Guild) {
        console.log(`Joined guild ${guild.name}`);
        this.voiceManager.scanGuild(guild);
    }

    private async handleInteractionCreate(interaction: any) {
        if (!interaction.isCommand()) return;

        switch (interaction.commandName) {
            case "joinchannel":
                await this.voiceManager.handleJoinChannelCommand(interaction);
                break;
            case "leavechannel":
                await this.voiceManager.handleLeaveChannelCommand(interaction);
                break;
        }
    }

    private async onReady() {
        const guilds = await this.client.guilds.fetch();
        for (const [, guild] of guilds) {
            const fullGuild = await guild.fetch();
            this.voiceManager.scanGuild(fullGuild);
        }
    }
}

const DiscordClientInterface: ElizaClient = {
    name: 'discord',
    start: async (runtime: IAgentRuntime) => new DiscordClient(runtime),
};

const testSuite: TestSuite = {
    name: "discord",
    tests: [
        {
            name: "discord",
            fn: async (runtime: IAgentRuntime) => {
                const discordClient = new DiscordClient(runtime);
                console.log("Created a discord client");
            }
        }
    ]
};

const discordPlugin: Plugin = {
    name: "discord",
    description: "Discord client plugin",
    clients: [DiscordClientInterface],
    actions: [
        reply,
        chat_with_attachments,
        download_media,
        joinvoice,
        leavevoice,
        summarize,
        transcribe_media,
    ],
    providers: [
        channelStateProvider,
        voiceStateProvider,
    ],
    tests: [
        testSuite,
    ]
};
export default discordPlugin;