import { Client } from "@microsoft/microsoft-graph-client";
import {
  type Activity,
  ActivityTypes,
  Attachment,
  CardFactory,
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  type ConfigurationBotFrameworkAuthenticationOptions,
  type ConversationReference,
  TurnContext,
} from "botbuilder";
import type { MSTeamsCredentials, MSTeamsSettings } from "./environment";
import type {
  AdaptiveCard,
  MSTeamsConversationReference,
  MSTeamsGraphFile,
  MSTeamsGraphUser,
  MSTeamsSendOptions,
  MSTeamsSendResult,
  MSTeamsUser,
} from "./types";

/** Maximum message length for MS Teams */
export const MAX_MESSAGE_LENGTH = 4000;

/** MS Teams media size limit (100MB) */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

/** File consent threshold (4MB) */
export const FILE_CONSENT_THRESHOLD_BYTES = 4 * 1024 * 1024;

/**
 * MS Teams Bot Framework client
 */
export class MSTeamsClient {
  private adapter: CloudAdapter;
  private credentials: MSTeamsCredentials;
  private settings: MSTeamsSettings;
  private conversationRefs: Map<string, Partial<ConversationReference>> =
    new Map();
  private graphClient?: Client;

  constructor(credentials: MSTeamsCredentials, settings: MSTeamsSettings) {
    this.credentials = credentials;
    this.settings = settings;

    const authConfig: ConfigurationBotFrameworkAuthenticationOptions = {
      MicrosoftAppId: credentials.appId,
      MicrosoftAppPassword: credentials.appPassword,
      MicrosoftAppTenantId: credentials.tenantId,
      MicrosoftAppType: "SingleTenant",
    };

    const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication(
      authConfig,
    );
    this.adapter = new CloudAdapter(botFrameworkAuth);
  }

  /**
   * Get the Bot Framework adapter
   */
  getAdapter(): CloudAdapter {
    return this.adapter;
  }

  /**
   * Get the credentials
   */
  getCredentials(): MSTeamsCredentials {
    return this.credentials;
  }

  /**
   * Initialize the Graph API client for user/file operations
   */
  async initGraphClient(accessToken: string): Promise<void> {
    this.graphClient = Client.init({
      authProvider: (done) => {
        done(null, accessToken);
      },
    });
  }

  /**
   * Store a conversation reference for proactive messaging
   */
  storeConversationReference(context: TurnContext): void {
    const ref = TurnContext.getConversationReference(context.activity);
    const conversationId = ref.conversation?.id;
    if (conversationId) {
      this.conversationRefs.set(conversationId, ref);
    }
  }

  /**
   * Get a stored conversation reference
   */
  getConversationReference(
    conversationId: string,
  ): Partial<ConversationReference> | undefined {
    return this.conversationRefs.get(conversationId);
  }

  /**
   * Send a proactive message to a conversation
   */
  async sendProactiveMessage(
    conversationId: string,
    text: string,
    options?: MSTeamsSendOptions,
  ): Promise<MSTeamsSendResult> {
    const ref = this.conversationRefs.get(conversationId);
    if (!ref) {
      throw new Error(`No conversation reference found for ${conversationId}`);
    }

    let messageId = "";
    let activityId = "";

    await this.adapter.continueConversationAsync(
      this.credentials.appId,
      ref as ConversationReference,
      async (context) => {
        const activity = this.buildActivity(text, options);
        const response = await context.sendActivity(activity);
        messageId = response?.id ?? "";
        activityId = context.activity.id ?? "";
      },
    );

    return {
      messageId,
      conversationId,
      activityId,
    };
  }

  /**
   * Send an Adaptive Card to a conversation
   */
  async sendAdaptiveCard(
    conversationId: string,
    card: AdaptiveCard,
    fallbackText?: string,
  ): Promise<MSTeamsSendResult> {
    const ref = this.conversationRefs.get(conversationId);
    if (!ref) {
      throw new Error(`No conversation reference found for ${conversationId}`);
    }

    let messageId = "";

    await this.adapter.continueConversationAsync(
      this.credentials.appId,
      ref as ConversationReference,
      async (context) => {
        const cardAttachment = CardFactory.adaptiveCard(card);
        const activity = {
          type: ActivityTypes.Message,
          attachments: [cardAttachment],
          text: fallbackText,
        };
        const response = await context.sendActivity(activity);
        messageId = response?.id ?? "";
      },
    );

    return {
      messageId,
      conversationId,
    };
  }

  /**
   * Send a poll as an Adaptive Card
   */
  async sendPoll(
    conversationId: string,
    question: string,
    options: string[],
    maxSelections = 1,
  ): Promise<MSTeamsSendResult & { pollId: string }> {
    const pollId = crypto.randomUUID();
    const cappedMaxSelections = Math.min(
      Math.max(1, maxSelections),
      options.length,
    );

    const choices = options.map((option, index) => ({
      title: option,
      value: String(index),
    }));

    const hint =
      cappedMaxSelections > 1
        ? `Select up to ${cappedMaxSelections} options.`
        : "Select one option.";

    const card: AdaptiveCard = {
      type: "AdaptiveCard",
      version: "1.5",
      body: [
        {
          type: "TextBlock",
          text: question,
          wrap: true,
          weight: "Bolder",
          size: "Medium",
        },
        {
          type: "Input.ChoiceSet",
          id: "choices",
          isMultiSelect: cappedMaxSelections > 1,
          style: "expanded",
          choices,
        },
        {
          type: "TextBlock",
          text: hint,
          wrap: true,
          isSubtle: true,
          spacing: "Small",
        },
      ],
      actions: [
        {
          type: "Action.Submit",
          title: "Vote",
          data: {
            pollId,
            action: "vote",
          },
        },
      ],
    };

    const fallbackLines = [
      `Poll: ${question}`,
      ...options.map((option, index) => `${index + 1}. ${option}`),
    ];

    const result = await this.sendAdaptiveCard(
      conversationId,
      card,
      fallbackLines.join("\n"),
    );

    return {
      ...result,
      pollId,
    };
  }

  /**
   * Reply to a message
   */
  async replyToMessage(
    context: TurnContext,
    text: string,
    options?: MSTeamsSendOptions,
  ): Promise<MSTeamsSendResult> {
    const activity = this.buildActivity(text, options);
    const response = await context.sendActivity(activity);

    return {
      messageId: response?.id ?? "",
      conversationId: context.activity.conversation?.id ?? "",
      activityId: response?.id,
    };
  }

  /**
   * Update an existing message
   */
  async updateMessage(
    context: TurnContext,
    activityId: string,
    text: string,
  ): Promise<void> {
    await context.updateActivity({
      id: activityId,
      type: ActivityTypes.Message,
      text,
    });
  }

  /**
   * Delete a message
   */
  async deleteMessage(context: TurnContext, activityId: string): Promise<void> {
    await context.deleteActivity(activityId);
  }

  /**
   * Get user information from Graph API
   */
  async getUserInfo(userId: string): Promise<MSTeamsGraphUser | null> {
    if (!this.graphClient) {
      return null;
    }

    try {
      const user = await this.graphClient
        .api(`/users/${userId}`)
        .select(
          "id,displayName,mail,userPrincipalName,jobTitle,department,officeLocation",
        )
        .get();

      return {
        id: user.id,
        displayName: user.displayName,
        mail: user.mail,
        userPrincipalName: user.userPrincipalName,
        jobTitle: user.jobTitle,
        department: user.department,
        officeLocation: user.officeLocation,
      };
    } catch {
      return null;
    }
  }

  /**
   * Upload a file to OneDrive via Graph API
   */
  async uploadFile(
    buffer: Buffer,
    filename: string,
    contentType: string,
  ): Promise<MSTeamsGraphFile | null> {
    if (!this.graphClient) {
      return null;
    }

    try {
      // Upload to OneDrive root
      const uploadPath = `/me/drive/root:/${filename}:/content`;
      const response = await this.graphClient
        .api(uploadPath)
        .header("Content-Type", contentType)
        .put(buffer);

      // Create a sharing link
      const shareLink = await this.graphClient
        .api(`/me/drive/items/${response.id}/createLink`)
        .post({
          type: "view",
          scope: "organization",
        });

      return {
        id: response.id,
        name: response.name,
        webUrl: response.webUrl,
        downloadUrl: shareLink.link?.webUrl,
        size: response.size,
        mimeType: contentType,
      };
    } catch {
      return null;
    }
  }

  /**
   * Build an activity from text and options
   */
  private buildActivity(
    text: string,
    options?: MSTeamsSendOptions,
  ): Partial<Activity> {
    const activity: Partial<Activity> = {
      type: ActivityTypes.Message,
      text,
    };

    // Add Adaptive Card if provided
    if (options?.adaptiveCard) {
      activity.attachments = [CardFactory.adaptiveCard(options.adaptiveCard)];
    }

    // Add mentions
    if (options?.mentions && options.mentions.length > 0) {
      activity.entities = options.mentions.map((mention) => ({
        type: "mention",
        mentioned: {
          id: mention.mentioned.id,
          name: mention.mentioned.name,
        },
        text: mention.text,
      }));
    }

    // Set reply to ID
    if (options?.replyToId) {
      activity.replyToId = options.replyToId;
    }

    return activity;
  }

  /**
   * Split a long message into chunks
   */
  splitMessage(text: string): string[] {
    if (text.length <= MAX_MESSAGE_LENGTH) {
      return [text];
    }

    const parts: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= MAX_MESSAGE_LENGTH) {
        parts.push(remaining);
        break;
      }

      // Find a good split point (prefer newlines, then spaces)
      let splitIndex = MAX_MESSAGE_LENGTH;

      const lastNewline = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
      if (lastNewline > MAX_MESSAGE_LENGTH / 2) {
        splitIndex = lastNewline + 1;
      } else {
        const lastSpace = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
        if (lastSpace > MAX_MESSAGE_LENGTH / 2) {
          splitIndex = lastSpace + 1;
        }
      }

      parts.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex);
    }

    return parts;
  }

  /**
   * Extract conversation reference from turn context
   */
  static extractConversationReference(
    context: TurnContext,
  ): MSTeamsConversationReference {
    const activity = context.activity;
    return {
      activityId: activity.id,
      user: activity.from
        ? {
            id: activity.from.id,
            name: activity.from.name,
            aadObjectId: activity.from.aadObjectId,
          }
        : undefined,
      bot: activity.recipient
        ? {
            id: activity.recipient.id,
            name: activity.recipient.name,
          }
        : undefined,
      conversation: {
        id: activity.conversation?.id ?? "",
        conversationType: activity.conversation?.conversationType as
          | "personal"
          | "groupChat"
          | "channel"
          | undefined,
        tenantId: activity.conversation?.tenantId,
        name: activity.conversation?.name,
        isGroup: activity.conversation?.isGroup,
      },
      channelId: activity.channelId ?? "msteams",
      serviceUrl: activity.serviceUrl,
      locale: activity.locale,
    };
  }

  /**
   * Strip mention tags from message text
   */
  static stripMentionTags(text: string): string {
    // Teams wraps mentions in <at>...</at> tags
    return text.replace(/<at[^>]*>.*?<\/at>/gi, "").trim();
  }

  /**
   * Check if the bot was mentioned in an activity
   */
  static wasBotMentioned(context: TurnContext): boolean {
    const botId = context.activity.recipient?.id;
    if (!botId) return false;

    const entities = context.activity.entities ?? [];
    return entities.some(
      (e) => e.type === "mention" && (e.mentioned as MSTeamsUser)?.id === botId,
    );
  }
}
