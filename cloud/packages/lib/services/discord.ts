import { logger } from "@/lib/utils/logger";

const DISCORD_API = "https://discord.com/api/v10";

async function discordPost(token: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${DISCORD_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/**
 * Discord notification service using Discord.js REST API
 * Send custom events, logs, and errors to Discord channels
 *
 * Setup:
 * 1. Create a Discord bot at https://discord.com/developers/applications
 * 2. Set DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID environment variables
 * 3. Invite bot to your server with "Send Messages" permission
 *
 * @see https://discord.js.org/docs/packages/rest/2.6.0
 */

/**
 * Discord embed field structure.
 */
export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/**
 * Discord embed structure.
 */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  timestamp?: string;
  footer?: {
    text: string;
    icon_url?: string;
  };
  author?: {
    name: string;
    icon_url?: string;
    url?: string;
  };
  thumbnail?: {
    url: string;
  };
  image?: {
    url: string;
  };
}

/**
 * Options for Discord message.
 */
export interface DiscordMessageOptions {
  content?: string;
  embeds?: DiscordEmbed[];
}

/**
 * Discord embed color constants.
 */
export enum DiscordColor {
  SUCCESS = 0x00ff00, // Green
  INFO = 0x0099ff, // Blue
  WARNING = 0xffaa00, // Orange
  ERROR = 0xff0000, // Red
  DEFAULT = 0x5865f2, // Discord Blurple
}

/**
 * Discord notification service for sending messages and embeds to Discord channels.
 */
class DiscordService {
  private botToken: string | null = null;
  private defaultChannelId: string | null = null;
  private initialized = false;

  private initialize(): void {
    if (this.initialized) return;

    const botToken = process.env.DISCORD_BOT_TOKEN;
    const channelId = process.env.DISCORD_CHANNEL_ID;

    if (!botToken || !channelId) {
      logger.warn("[DiscordService] Not configured. Set DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID");
      this.initialized = false;
      return;
    }

    this.botToken = botToken;
    this.defaultChannelId = channelId;
    this.initialized = true;
    logger.info("[DiscordService] Initialized successfully");
  }

  /**
   * Send a message to Discord
   */
  async send(options: DiscordMessageOptions, channelId?: string): Promise<boolean> {
    this.initialize();

    if (!this.initialized || !this.botToken || !this.defaultChannelId) {
      logger.warn("[DiscordService] Not initialized, skipping Discord message");
      return false;
    }

    const targetChannel = channelId || this.defaultChannelId;

    await discordPost(this.botToken, `/channels/${targetChannel}/messages`, {
      content: options.content,
      embeds: options.embeds,
    });

    logger.info(`[DiscordService] Message sent to channel ${targetChannel}`);
    return true;
  }

  /**
   * Send a message to a specific channel
   */
  async sendToChannel(channelId: string, options: DiscordMessageOptions): Promise<boolean> {
    return this.send(options, channelId);
  }

  /**
   * Send a simple text message
   */
  async sendText(message: string, channelId?: string): Promise<boolean> {
    return this.send({ content: message }, channelId);
  }

  /**
   * Create a Discord thread for a conversation
   */
  async createThread(data: {
    name: string;
    message?: string;
    autoArchiveDuration?: 60 | 1440 | 4320 | 10080; // minutes
  }): Promise<{ success: boolean; threadId?: string; error?: string }> {
    this.initialize();

    if (!this.initialized || !this.botToken || !this.defaultChannelId) {
      return { success: false, error: "Discord not initialized" };
    }

    interface ThreadCreateData {
      name: string;
      auto_archive_duration: number;
      type: number;
      message?: { content: string };
    }

    const threadData: ThreadCreateData = {
      name: data.name.slice(0, 100),
      auto_archive_duration: data.autoArchiveDuration || 1440,
      type: 11, // PUBLIC_THREAD
    };

    if (data.message) {
      threadData.message = { content: data.message };
    }

    const res = await discordPost(
      this.botToken,
      `/channels/${this.defaultChannelId}/threads`,
      threadData,
    );
    const response = (await res.json()) as { id: string };

    logger.info(`[DiscordService] Thread created: ${response.id}`);

    return {
      success: true,
      threadId: response.id,
    };
  }

  /**
   * Send a message to a Discord thread
   */
  async sendToThread(threadId: string, message: string): Promise<boolean> {
    this.initialize();

    if (!this.initialized || !this.botToken) {
      logger.warn("[DiscordService] Not initialized, skipping thread message");
      return false;
    }

    await discordPost(this.botToken, `/channels/${threadId}/messages`, {
      content: message,
    });

    logger.info(`[DiscordService] Message sent to thread ${threadId}`);
    return true;
  }

  /**
   * Log a user signup event
   */
  async logUserSignup(userData: {
    userId: string;
    stewardUserId: string;
    email?: string | null;
    name?: string | null;
    walletAddress?: string | null;
    organizationId: string;
    organizationName: string;
    role: string;
    isNewOrganization: boolean;
  }): Promise<boolean> {
    const fields: DiscordEmbedField[] = [
      {
        name: "User ID",
        value: `\`${userData.userId}\``,
        inline: true,
      },
      {
        name: "Steward ID",
        value: `\`${userData.stewardUserId}\``,
        inline: true,
      },
      {
        name: "Role",
        value: userData.role,
        inline: true,
      },
    ];

    if (userData.email) {
      fields.push({
        name: "Email",
        value: userData.email,
        inline: false,
      });
    }

    if (userData.name) {
      fields.push({
        name: "Name",
        value: userData.name,
        inline: true,
      });
    }

    if (userData.walletAddress) {
      fields.push({
        name: "Wallet",
        value: `\`${userData.walletAddress.slice(0, 8)}...${userData.walletAddress.slice(-6)}\``,
        inline: true,
      });
    }

    fields.push(
      {
        name: "Organization",
        value: userData.organizationName,
        inline: false,
      },
      {
        name: "Organization ID",
        value: `\`${userData.organizationId}\``,
        inline: false,
      },
      {
        name: "New Organization",
        value: userData.isNewOrganization ? "✅ Yes" : "❌ No (Joined via invite)",
        inline: true,
      },
    );

    const embed: DiscordEmbed = {
      title: "🎉 New User Signup",
      description: userData.isNewOrganization
        ? "A new user has signed up and created an organization!"
        : "A user has accepted an invite and joined an organization!",
      color: DiscordColor.SUCCESS,
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: "Eliza Cloud",
      },
    };

    return this.send({
      embeds: [embed],
    });
  }

  /**
   * Log an error
   */
  async logError(error: {
    title: string;
    message: string;
    stack?: string;
    context?: Record<string, any>;
  }): Promise<boolean> {
    const fields: DiscordEmbedField[] = [
      {
        name: "Error Message",
        value: `\`\`\`${error.message.slice(0, 1000)}\`\`\``,
        inline: false,
      },
    ];

    if (error.stack) {
      fields.push({
        name: "Stack Trace",
        value: `\`\`\`${error.stack.slice(0, 1000)}\`\`\``,
        inline: false,
      });
    }

    if (error.context) {
      fields.push({
        name: "Context",
        value: `\`\`\`json\n${JSON.stringify(error.context, null, 2).slice(0, 1000)}\`\`\``,
        inline: false,
      });
    }

    const embed: DiscordEmbed = {
      title: `❌ ${error.title}`,
      color: DiscordColor.ERROR,
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: "Eliza Cloud - Error Tracker",
      },
    };

    return this.send({
      embeds: [embed],
    });
  }

  /**
   * Log a video generation event
   */
  async logVideoGenerated(videoData: {
    generationId: string;
    prompt: string;
    videoUrl: string;
    userName?: string | null;
    userId: string;
    organizationId: string;
    organizationName?: string;
    model?: string;
    width?: number;
    height?: number;
    fileSize?: number;
    cost?: number;
  }): Promise<boolean> {
    const fields: DiscordEmbedField[] = [
      {
        name: "Prompt",
        value: videoData.prompt.slice(0, 200) + (videoData.prompt.length > 200 ? "..." : ""),
        inline: false,
      },
      {
        name: "Generated By",
        value: videoData.userName || "Unknown",
        inline: true,
      },
      {
        name: "User ID",
        value: `\`${videoData.userId}\``,
        inline: true,
      },
    ];

    if (videoData.organizationName) {
      fields.push({
        name: "Organization",
        value: videoData.organizationName,
        inline: true,
      });
    }

    fields.push({
      name: "Organization ID",
      value: `\`${videoData.organizationId}\``,
      inline: false,
    });

    if (videoData.model) {
      fields.push({
        name: "Model",
        value: videoData.model,
        inline: true,
      });
    }

    if (videoData.width && videoData.height) {
      fields.push({
        name: "Resolution",
        value: `${videoData.width}x${videoData.height}`,
        inline: true,
      });
    }

    if (videoData.fileSize) {
      const sizeMB = (videoData.fileSize / (1024 * 1024)).toFixed(2);
      fields.push({
        name: "File Size",
        value: `${sizeMB} MB`,
        inline: true,
      });
    }

    if (videoData.cost !== undefined) {
      fields.push({
        name: "Cost",
        value: `$${videoData.cost.toFixed(2)}`,
        inline: true,
      });
    }

    fields.push({
      name: "Generation ID",
      value: `\`${videoData.generationId}\``,
      inline: false,
    });

    // Add video URL as a clickable link
    fields.push({
      name: "Video URL",
      value: `[Watch Video](${videoData.videoUrl})`,
      inline: false,
    });

    const embed: DiscordEmbed = {
      title: "🎬 New Video Generated",
      description: `A new AI video has been generated on Eliza Cloud!`,
      color: DiscordColor.SUCCESS,
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: "Eliza Cloud - Video Generation",
      },
    };

    // Send embed with video URL as content for preview
    // Discord will auto-embed video URLs when they're in the message content
    return this.send({
      content: videoData.videoUrl,
      embeds: [embed],
    });
  }

  /**
   * Log an image generation event
   */
  async logImageGenerated(imageData: {
    generationId: string;
    prompt: string;
    imageUrl: string;
    userName?: string | null;
    userId: string;
    organizationName: string;
    numImages: number;
    aspectRatio?: string;
    model?: string;
  }): Promise<boolean> {
    const fields: DiscordEmbedField[] = [
      {
        name: "Prompt",
        value: imageData.prompt.slice(0, 200) + (imageData.prompt.length > 200 ? "..." : ""),
        inline: false,
      },
      {
        name: "Generated By",
        value: imageData.userName || "Unknown",
        inline: true,
      },
      {
        name: "Organization",
        value: imageData.organizationName,
        inline: true,
      },
      {
        name: "Number of Images",
        value: imageData.numImages.toString(),
        inline: true,
      },
    ];

    if (imageData.aspectRatio) {
      fields.push({
        name: "Aspect Ratio",
        value: imageData.aspectRatio,
        inline: true,
      });
    }

    if (imageData.model) {
      fields.push({
        name: "Model",
        value: imageData.model,
        inline: true,
      });
    }

    fields.push({
      name: "Generation ID",
      value: `\`${imageData.generationId}\``,
      inline: false,
    });

    const embed: DiscordEmbed = {
      title: "🎨 New Image Generated",
      description: `An AI image has been generated!`,
      color: DiscordColor.SUCCESS,
      fields,
      image: {
        url: imageData.imageUrl,
      },
      timestamp: new Date().toISOString(),
      footer: {
        text: "Eliza Cloud - Image Generation",
      },
    };

    return this.send({
      embeds: [embed],
    });
  }

  /**
   * Log an app creation event
   */
  async logAppCreated(appData: {
    appId: string;
    appName: string;
    slug: string;
    userName?: string | null;
    userId: string;
    organizationId: string;
    organizationName?: string;
    appUrl: string;
    description?: string;
    githubRepo?: string;
    subdomain?: string;
  }): Promise<boolean> {
    const fields: DiscordEmbedField[] = [
      {
        name: "App Name",
        value: appData.appName,
        inline: true,
      },
      {
        name: "Slug",
        value: `\`${appData.slug}\``,
        inline: true,
      },
      {
        name: "App ID",
        value: `\`${appData.appId}\``,
        inline: false,
      },
      {
        name: "Created By",
        value: appData.userName || "Unknown",
        inline: true,
      },
      {
        name: "User ID",
        value: `\`${appData.userId}\``,
        inline: true,
      },
    ];

    if (appData.organizationName) {
      fields.push({
        name: "Organization",
        value: appData.organizationName,
        inline: true,
      });
    }

    fields.push({
      name: "Organization ID",
      value: `\`${appData.organizationId}\``,
      inline: false,
    });

    if (appData.description) {
      fields.push({
        name: "Description",
        value: appData.description.slice(0, 200) + (appData.description.length > 200 ? "..." : ""),
        inline: false,
      });
    }

    fields.push({
      name: "App URL",
      value: appData.appUrl,
      inline: false,
    });

    if (appData.githubRepo) {
      fields.push({
        name: "GitHub Repo",
        value: `[\`${appData.githubRepo}\`](https://github.com/${appData.githubRepo})`,
        inline: true,
      });
    }

    if (appData.subdomain) {
      fields.push({
        name: "Subdomain",
        value: `\`${appData.subdomain}\``,
        inline: true,
      });
    }

    const embed: DiscordEmbed = {
      title: "📱 New App Created",
      description: `A new app has been created on Eliza Cloud!`,
      color: DiscordColor.SUCCESS,
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: "Eliza Cloud",
      },
    };

    return this.send({
      embeds: [embed],
    });
  }

  /**
   * Log a container launch event
   */
  async logContainerLaunched(containerData: {
    containerId: string;
    containerName: string;
    projectName: string;
    userName?: string | null;
    userId: string;
    organizationId: string;
    organizationName?: string;
    ecrImageUri: string;
    cpu: number;
    memory: number;
    port: number;
    desiredCount: number;
    cost: number;
    stackName?: string;
  }): Promise<boolean> {
    const fields: DiscordEmbedField[] = [
      {
        name: "Container Name",
        value: containerData.containerName,
        inline: true,
      },
      {
        name: "Project",
        value: `\`${containerData.projectName}\``,
        inline: true,
      },
      {
        name: "Container ID",
        value: `\`${containerData.containerId}\``,
        inline: false,
      },
      {
        name: "Launched By",
        value: containerData.userName || "Unknown",
        inline: true,
      },
      {
        name: "User ID",
        value: `\`${containerData.userId}\``,
        inline: true,
      },
    ];

    if (containerData.organizationName) {
      fields.push({
        name: "Organization",
        value: containerData.organizationName,
        inline: true,
      });
    }

    fields.push({
      name: "Organization ID",
      value: `\`${containerData.organizationId}\``,
      inline: false,
    });

    fields.push(
      {
        name: "Resources",
        value: `${containerData.cpu} CPU / ${containerData.memory} MB`,
        inline: true,
      },
      {
        name: "Port",
        value: containerData.port.toString(),
        inline: true,
      },
      {
        name: "Instances",
        value: containerData.desiredCount.toString(),
        inline: true,
      },
      {
        name: "Cost",
        value: `$${containerData.cost.toFixed(2)}`,
        inline: true,
      },
    );

    if (containerData.stackName) {
      fields.push({
        name: "Container",
        value: `\`${containerData.stackName}\``,
        inline: false,
      });
    }

    fields.push({
      name: "Image",
      value: `\`${containerData.ecrImageUri.slice(0, 80)}${containerData.ecrImageUri.length > 80 ? "..." : ""}\``,
      inline: false,
    });

    const embed: DiscordEmbed = {
      title: "🐳 New Container Launched",
      description: `A new container has been launched on Eliza Cloud!`,
      color: DiscordColor.SUCCESS,
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: "Eliza Cloud - Container Deployments",
      },
    };

    return this.send({
      embeds: [embed],
    });
  }

  /**
   * Log a character creation event
   */
  async logCharacterCreated(characterData: {
    characterId: string;
    characterName: string;
    userName?: string | null;
    userId: string;
    organizationName: string;
    bio?: string;
    plugins?: string[];
  }): Promise<boolean> {
    const fields: DiscordEmbedField[] = [
      {
        name: "Character Name",
        value: characterData.characterName,
        inline: true,
      },
      {
        name: "Character ID",
        value: `\`${characterData.characterId}\``,
        inline: true,
      },
      {
        name: "Created By",
        value: characterData.userName || "Unknown",
        inline: true,
      },
      {
        name: "User ID",
        value: `\`${characterData.userId}\``,
        inline: true,
      },
      {
        name: "Organization",
        value: characterData.organizationName,
        inline: true,
      },
    ];

    if (characterData.bio) {
      const bioText = Array.isArray(characterData.bio)
        ? characterData.bio.join(" ")
        : characterData.bio;
      fields.push({
        name: "Bio",
        value: bioText.slice(0, 200) + (bioText.length > 200 ? "..." : ""),
        inline: false,
      });
    }

    if (characterData.plugins && characterData.plugins.length > 0) {
      fields.push({
        name: "Plugins",
        value:
          characterData.plugins.slice(0, 5).join(", ") +
          (characterData.plugins.length > 5 ? `, +${characterData.plugins.length - 5} more` : ""),
        inline: false,
      });
    }

    const embed: DiscordEmbed = {
      title: "🤖 New Character Created",
      description: `A new AI character has been created!`,
      color: DiscordColor.SUCCESS,
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: "Eliza Cloud",
      },
    };

    return this.send({
      embeds: [embed],
    });
  }

  /**
   * Log a custom event
   */
  async logEvent(event: {
    title: string;
    description?: string;
    fields?: DiscordEmbedField[];
    color?: DiscordColor;
  }): Promise<boolean> {
    const embed: DiscordEmbed = {
      title: event.title,
      description: event.description,
      color: event.color || DiscordColor.INFO,
      fields: event.fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: "Eliza Cloud",
      },
    };

    return this.send({
      embeds: [embed],
    });
  }

  /**
   * Log a warning
   */
  async logWarning(warning: {
    title: string;
    message: string;
    context?: Record<string, any>;
  }): Promise<boolean> {
    const fields: DiscordEmbedField[] = [
      {
        name: "Message",
        value: warning.message,
        inline: false,
      },
    ];

    if (warning.context) {
      fields.push({
        name: "Context",
        value: `\`\`\`json\n${JSON.stringify(warning.context, null, 2).slice(0, 1000)}\`\`\``,
        inline: false,
      });
    }

    const embed: DiscordEmbed = {
      title: `⚠️ ${warning.title}`,
      color: DiscordColor.WARNING,
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: "Eliza Cloud",
      },
    };

    return this.send({
      embeds: [embed],
    });
  }

  /**
   * Log a payment received event with role mention for notifications
   */
  async logPaymentReceived(paymentData: {
    paymentId: string;
    amount: number;
    currency: string;
    credits: number;
    organizationId: string;
    organizationName?: string;
    userId?: string;
    userName?: string | null;
    paymentMethod: "stripe" | "crypto";
    paymentType: string;
    network?: string;
  }): Promise<boolean> {
    // Get celebration level based on amount
    const celebration = this.getPaymentCelebration(paymentData.amount);

    const fields: DiscordEmbedField[] = [
      {
        name: "💵 Amount",
        value: `**$${paymentData.amount.toFixed(2)}** ${paymentData.currency.toUpperCase()}`,
        inline: true,
      },
      {
        name: "✨ Credits Added",
        value: `**$${paymentData.credits.toFixed(2)}**`,
        inline: true,
      },
      {
        name: "💳 Payment Method",
        value: paymentData.paymentMethod === "stripe" ? "Stripe" : "🪙 Crypto",
        inline: true,
      },
    ];

    if (paymentData.network) {
      fields.push({
        name: "🌐 Network",
        value: paymentData.network,
        inline: true,
      });
    }

    fields.push({
      name: "📦 Type",
      value: paymentData.paymentType,
      inline: true,
    });

    if (paymentData.userName) {
      fields.push({
        name: "👤 User",
        value: paymentData.userName,
        inline: true,
      });
    }

    if (paymentData.organizationName) {
      fields.push({
        name: "🏢 Organization",
        value: paymentData.organizationName,
        inline: false,
      });
    }

    fields.push({
      name: "🔗 Payment ID",
      value: `\`${paymentData.paymentId.slice(0, 30)}...\``,
      inline: false,
    });

    const embed: DiscordEmbed = {
      title: `${celebration.emoji} ${celebration.title}`,
      description: celebration.message.replace("{amount}", paymentData.amount.toFixed(2)),
      color: celebration.color,
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: "Eliza Cloud • Ka-ching! 🔔",
      },
    };

    // Build content with optional role mention for notification sound
    const paymentAlertRoleId = process.env.DISCORD_PAYMENT_ALERT_ROLE_ID;
    const roleMention = paymentAlertRoleId ? `<@&${paymentAlertRoleId}> ` : "";
    const content = `${roleMention}${celebration.announcement}`;

    return this.send({
      content,
      embeds: [embed],
    });
  }

  /**
   * Get celebration level based on payment amount
   */
  private getPaymentCelebration(amount: number): {
    emoji: string;
    title: string;
    message: string;
    announcement: string;
    color: number;
  } {
    if (amount >= 500) {
      return {
        emoji: "🎰",
        title: "MASSIVE PAYMENT RECEIVED!",
        message: "🚀 **HUGE WIN!** A payment of **$${amount}** just landed! 🎊🎉🎈",
        announcement: "💎💎💎 **WHALE ALERT** 💎💎💎",
        color: 0xffd700, // Gold
      };
    }
    if (amount >= 100) {
      return {
        emoji: "🎉",
        title: "Big Payment Received!",
        message: "🔥 A solid **$${amount}** payment just came through! Nice! 🔥",
        announcement: "🎊 **Cha-ching!** Big money incoming!",
        color: 0x00ff88, // Bright green
      };
    }
    if (amount >= 50) {
      return {
        emoji: "💰",
        title: "Payment Received!",
        message: "💵 Sweet! **$${amount}** added to the treasury! 💵",
        announcement: "💰 New payment received!",
        color: 0x00ff00, // Green
      };
    }
    if (amount >= 10) {
      return {
        emoji: "💵",
        title: "Payment Received",
        message: "A payment of **$${amount}** has been received!",
        announcement: "💵 Payment incoming!",
        color: DiscordColor.SUCCESS,
      };
    }
    return {
      emoji: "🪙",
      title: "Payment Received",
      message: "**$${amount}** received - every bit counts! 🙌",
      announcement: "🪙 New payment!",
      color: DiscordColor.SUCCESS,
    };
  }
}

export const discordService = new DiscordService();
