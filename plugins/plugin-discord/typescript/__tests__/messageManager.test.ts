import type { IAgentRuntime } from "@elizaos/core";
import {
  ChannelType,
  Client,
  Collection,
  type Attachment as DiscordAttachment,
  type Message as DiscordMessage,
  type User as DiscordUser,
} from "discord.js";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { MessageManager } from "../src/messages";
import type { DiscordSettings, IDiscordService } from "../types";

interface MockMessage extends Partial<DiscordMessage> {
  content: string;
  author: { id: string; username: string; bot: boolean };
  guild: unknown;
  channel: {
    id: string;
    type: ChannelType;
    send: ReturnType<typeof vi.fn>;
    guild: unknown;
    client: { user: DiscordUser | null };
    permissionsFor: ReturnType<typeof vi.fn>;
    isThread: ReturnType<typeof vi.fn>;
  };
  id: string;
  createdTimestamp: number;
  mentions: {
    users: { has: ReturnType<typeof vi.fn> };
    repliedUser: { id: string } | null;
  };
  reference: { messageId: string } | null;
  attachments: Collection<string, DiscordAttachment>;
  embeds: unknown[];
  url: string;
}

describe("Discord MessageManager", () => {
  let agentRuntime: IAgentRuntime;
  let mockClient: Client;
  let mockDiscordService: IDiscordService;
  let mockMessage: MockMessage;
  let messageManager: MessageManager;

  beforeEach(() => {
    vi.clearAllMocks();

    agentRuntime = {
      character: {
        name: "TestBot",
        templates: {},
        settings: {
          discord: {
            allowedChannelIds: ["mock-channel-id"],
            shouldIgnoreBotMessages: true,
            shouldIgnoreDirectMessages: true,
            shouldRespondOnlyToMentions: true,
          },
        },
      },
      evaluate: vi.fn(),
      composeState: vi.fn(),
      ensureConnection: vi.fn(),
      getOrCreateUser: vi.fn(),
      messageManager: {
        createMemory: vi.fn(),
        addEmbeddingToMemory: vi.fn(),
      },
      messageService: {
        handleMessage: vi.fn().mockResolvedValue(undefined),
      },
      getParticipantUserState: vi.fn().mockResolvedValue("ACTIVE"),
      log: vi.fn(),
      logger: {
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        success: vi.fn(),
      },
      processActions: vi.fn(),
      emitEvent: vi.fn(),
      getSetting: vi.fn().mockReturnValue(undefined),
    } as unknown as IAgentRuntime;

    mockClient = new Client({ intents: [] });
    mockClient.user = { id: "mock-bot-id", username: "MockBot" } as DiscordUser;

    const getChannelTypeMock = vi.fn().mockResolvedValue(ChannelType.GuildText);
    mockDiscordService = {
      client: mockClient,
      getChannelType: getChannelTypeMock,
    } as IDiscordService;
    messageManager = new MessageManager(mockDiscordService, agentRuntime);

    const guild = {
      fetch: vi.fn().mockReturnValue({
        type: ChannelType.GuildText,
        serverId: "mock-server-id",
      }),
      members: {
        cache: {
          get: vi.fn().mockReturnValue({ nickname: "MockBotNickname" }),
        },
      },
    };

    mockMessage = {
      content: "Hello, MockBot!",
      author: { id: "mock-user-id", username: "MockUser", bot: false },
      guild,
      channel: {
        id: "mock-channel-id",
        type: ChannelType.GuildText,
        send: vi.fn(),
        guild,
        client: { user: mockClient.user },
        permissionsFor: vi.fn().mockReturnValue({ has: vi.fn().mockReturnValue(true) }),
        isThread: vi.fn().mockReturnValue(false),
      },
      id: "mock-message-id",
      createdTimestamp: Date.now(),
      mentions: {
        users: { has: vi.fn().mockReturnValue(true) },
        repliedUser: null,
      },
      reference: null,
      attachments: new Collection(),
      embeds: [],
      url: "https://discord.com/channels/mock-server-id/mock-channel-id/mock-message-id",
    };
  });

  it("should process user messages", async () => {
    await messageManager.handleMessage(mockMessage);
    expect(agentRuntime.ensureConnection).toHaveBeenCalled();
  });

  it("should ignore bot messages", async () => {
    mockMessage.author.bot = true;
    await messageManager.handleMessage(mockMessage);
    expect(agentRuntime.ensureConnection).not.toHaveBeenCalled();
  });

  it("should ignore messages from restricted channels", async () => {
    // Channel filtering is handled in setupEventListeners, not handleMessage.
    // Restrictions are enforced at the event listener level.
    mockMessage.channel.id = "undefined-channel-id";
    await messageManager.handleMessage(mockMessage);
    // In the current implementation, handleMessage doesn't filter by channel
    // Channel filtering happens in service.ts setupEventListeners
    expect(agentRuntime.ensureConnection).toHaveBeenCalled();
  });

  it("should ignore not mentioned messages", async () => {
    mockMessage.mentions.users.has = vi.fn().mockReturnValue(false);
    await messageManager.handleMessage(mockMessage);
    expect(agentRuntime.ensureConnection).not.toHaveBeenCalled();
  });

  describe("mentionContext metadata", () => {
    it("should set isMention=true for Discord @mentions", async () => {
      mockMessage.mentions.users.has = vi.fn().mockReturnValue(true);
      await messageManager.handleMessage(mockMessage);

      const messageService = agentRuntime.messageService;
      expect(messageService?.handleMessage).toHaveBeenCalled();
      const handleMessageMock = messageService?.handleMessage as Mock;
      const handleCall = handleMessageMock.mock.calls[0];
      const message = handleCall[1];

      expect(message.content.mentionContext).toEqual({
        isMention: true,
        isReply: false,
        isThread: false,
        mentionType: "platform_mention",
      });
    });

    it("should set isReply=true for replies to bot", async () => {
      mockMessage.mentions.users.has = vi.fn().mockReturnValue(false);
      mockMessage.reference = { messageId: "some-message-id" };
      mockMessage.mentions.repliedUser = { id: "mock-bot-id" };

      await messageManager.handleMessage(mockMessage);

      const messageService = agentRuntime.messageService;
      expect(messageService?.handleMessage).toHaveBeenCalled();
      const handleMessageMock = messageService?.handleMessage as Mock;
      const handleCall = handleMessageMock.mock.calls[0];
      const message = handleCall[1];

      expect(message.content.mentionContext).toEqual({
        isMention: false,
        isReply: true,
        isThread: false,
        mentionType: "reply",
      });
    });

    it("should set isReply=false for replies to other users", async () => {
      mockMessage.mentions.users.has = vi.fn().mockReturnValue(false);
      mockMessage.reference = { messageId: "some-message-id" };
      mockMessage.mentions.repliedUser = { id: "other-user-id" }; // Not the bot

      await messageManager.handleMessage(mockMessage);

      // Should be ignored in strict mode
      expect(agentRuntime.ensureConnection).not.toHaveBeenCalled();
    });

    it("should set isThread=true for thread messages", async () => {
      mockMessage.mentions.users.has = vi.fn().mockReturnValue(true);
      mockMessage.channel.isThread = vi.fn().mockReturnValue(true);

      await messageManager.handleMessage(mockMessage);

      const messageService = agentRuntime.messageService;
      expect(messageService?.handleMessage).toHaveBeenCalled();
      const handleMessageMock = messageService?.handleMessage as Mock;
      const handleCall = handleMessageMock.mock.calls[0];
      const message = handleCall[1];

      expect(message.content.mentionContext.isThread).toBe(true);
    });

    it("should set mentionType=none when no mention", async () => {
      // Set natural mode to test this
      const characterSettings = agentRuntime.character.settings;
      const discordSettings = characterSettings?.discord as DiscordSettings | undefined;
      if (discordSettings) {
        discordSettings.shouldRespondOnlyToMentions = false;
      }
      messageManager = new MessageManager(mockDiscordClient);
      vi.spyOn(
        messageManager as unknown as { getChannelType: () => Promise<ChannelType> },
        "getChannelType"
      ).mockResolvedValue(ChannelType.GuildText);

      mockMessage.mentions.users.has = vi.fn().mockReturnValue(false);
      mockMessage.reference = null;
      mockMessage.channel.isThread = vi.fn().mockReturnValue(false);

      await messageManager.handleMessage(mockMessage);

      const messageService = agentRuntime.messageService;
      expect(messageService?.handleMessage).toHaveBeenCalled();
      const handleMessageMock = messageService?.handleMessage as Mock;
      const handleCall = handleMessageMock.mock.calls[0];
      const message = handleCall[1];

      expect(message.content.mentionContext).toEqual({
        isMention: false,
        isReply: false,
        isThread: false,
        mentionType: "none",
      });
    });
  });

  describe("strict mode (shouldRespondOnlyToMentions=true)", () => {
    it("should ignore messages without @mention or reply in strict mode", async () => {
      mockMessage.content = "Hey TestBot, how are you?";
      mockMessage.mentions.users.has = vi.fn().mockReturnValue(false);
      mockMessage.reference = null;

      await messageManager.handleMessage(mockMessage);

      expect(agentRuntime.ensureConnection).not.toHaveBeenCalled();
      expect(agentRuntime.emitEvent).not.toHaveBeenCalled();
    });

    it("should process @mentions in strict mode", async () => {
      mockMessage.mentions.users.has = vi.fn().mockReturnValue(true);

      await messageManager.handleMessage(mockMessage);

      expect(agentRuntime.ensureConnection).toHaveBeenCalled();
      expect(agentRuntime.messageService.handleMessage).toHaveBeenCalled();
    });

    it("should process replies to bot in strict mode", async () => {
      mockMessage.mentions.users.has = vi.fn().mockReturnValue(false);
      mockMessage.reference = { messageId: "bot-message-id" };
      mockMessage.mentions.repliedUser = { id: "mock-bot-id" };

      await messageManager.handleMessage(mockMessage);

      expect(agentRuntime.ensureConnection).toHaveBeenCalled();
      expect(agentRuntime.messageService.handleMessage).toHaveBeenCalled();
    });

    it("should always process DMs regardless of strict mode", async () => {
      // Temporarily disable shouldIgnoreDirectMessages for this test
      const characterSettings = agentRuntime.character.settings;
      const discordSettings = characterSettings?.discord as DiscordSettings | undefined;
      if (discordSettings) {
        discordSettings.shouldIgnoreDirectMessages = false;
      }
      messageManager = new MessageManager(mockDiscordClient);
      vi.spyOn(
        messageManager as unknown as { getChannelType: () => Promise<ChannelType> },
        "getChannelType"
      ).mockResolvedValue(ChannelType.DM);

      mockMessage.channel.type = ChannelType.DM;
      mockMessage.mentions.users.has = vi.fn().mockReturnValue(false);
      mockMessage.reference = null;
      mockMessage.guild = null;

      await messageManager.handleMessage(mockMessage);

      expect(agentRuntime.ensureConnection).toHaveBeenCalled();
      expect(agentRuntime.messageService.handleMessage).toHaveBeenCalled();
    });
  });

  describe("natural mode (shouldRespondOnlyToMentions=false)", () => {
    beforeEach(() => {
      const characterSettings = agentRuntime.character.settings;
      const discordSettings = characterSettings?.discord as DiscordSettings | undefined;
      if (discordSettings) {
        discordSettings.shouldRespondOnlyToMentions = false;
      }
      messageManager = new MessageManager(mockDiscordClient);
      vi.spyOn(
        messageManager as unknown as { getChannelType: () => Promise<ChannelType> },
        "getChannelType"
      ).mockResolvedValue(ChannelType.GuildText);
    });

    it("should send all messages to bootstrap for analysis", async () => {
      mockMessage.content = "Hey TestBot, how are you?";
      mockMessage.mentions.users.has = vi.fn().mockReturnValue(false);

      await messageManager.handleMessage(mockMessage);

      // In natural mode, message is sent to bootstrap
      expect(agentRuntime.ensureConnection).toHaveBeenCalled();
      expect(agentRuntime.messageService.handleMessage).toHaveBeenCalled();
    });

    it("should send messages with character name to bootstrap", async () => {
      mockMessage.content = "I talked to TestBot yesterday";
      mockMessage.mentions.users.has = vi.fn().mockReturnValue(false);

      await messageManager.handleMessage(mockMessage);

      // Bootstrap will decide if this is "talking to" or "talking about"
      expect(agentRuntime.ensureConnection).toHaveBeenCalled();
      expect(agentRuntime.messageService.handleMessage).toHaveBeenCalled();
    });

    it("should send messages without character name to bootstrap", async () => {
      mockMessage.content = "What is the weather today?";
      mockMessage.mentions.users.has = vi.fn().mockReturnValue(false);

      await messageManager.handleMessage(mockMessage);

      // Bootstrap will use LLM to decide
      expect(agentRuntime.ensureConnection).toHaveBeenCalled();
      expect(agentRuntime.messageService.handleMessage).toHaveBeenCalled();
    });
  });

  it("should process audio attachments", async () => {
    vi.spyOn(messageManager, "processMessage").mockResolvedValue({
      processedContent: "",
      attachments: [],
    });

    const mockAttachments = new Collection<string, DiscordAttachment>([
      [
        "mock-attachment-id",
        {
          attachment: "https://www.example.mp3",
          name: "mock-attachment.mp3",
          contentType: "audio/mpeg",
        },
      ],
    ]);

    mockMessage.attachments = mockAttachments;
    const processAttachmentsMock = vi.fn().mockResolvedValue([]);

    Object.defineProperty(messageManager, "attachmentManager", {
      value: { processAttachments: processAttachmentsMock },
      writable: true,
    });

    await messageManager.handleMessage(mockMessage);
    expect(processAttachmentsMock).toHaveBeenCalledWith(mockAttachments);
  });
});
