import { type IAgentRuntime, Service } from "@elizaos/core";
import { INSTAGRAM_SERVICE_NAME, MAX_DM_LENGTH } from "./constants";
import type {
  InstagramConfig,
  InstagramMedia,
  InstagramMessage,
  InstagramThread,
  InstagramUser,
} from "./types";

/**
 * Instagram Service for elizaOS
 *
 * Provides Instagram integration including DMs, comments, and posts.
 */
export class InstagramService extends Service {
  static serviceType = INSTAGRAM_SERVICE_NAME;

  capabilityDescription = "Instagram messaging and social media integration";

  private instagramConfig: InstagramConfig | null = null;
  private isRunning = false;
  private loggedInUser: InstagramUser | null = null;

  /**
   * Static factory method to create and start the service
   */
  static override async start(
    runtime: IAgentRuntime,
  ): Promise<InstagramService> {
    const service = new InstagramService(runtime);
    await service.initialize();
    await service.startService();
    return service;
  }

  /**
   * Initialize the service
   */
  async initialize(): Promise<void> {
    // Load config from runtime settings
    const username = this.runtime.getSetting("INSTAGRAM_USERNAME");
    const password = this.runtime.getSetting("INSTAGRAM_PASSWORD");

    if (!username || !password) {
      console.warn(
        "Instagram credentials not configured. Service will not be available.",
      );
      return;
    }

    const verificationCode = this.runtime.getSetting(
      "INSTAGRAM_VERIFICATION_CODE",
    );
    const proxy = this.runtime.getSetting("INSTAGRAM_PROXY");
    const pollingIntervalStr = this.runtime.getSetting(
      "INSTAGRAM_POLLING_INTERVAL",
    );

    this.instagramConfig = {
      username: String(username),
      password: String(password),
      verificationCode:
        verificationCode != null ? String(verificationCode) : undefined,
      proxy: proxy != null ? String(proxy) : undefined,
      autoRespondToDms:
        this.runtime.getSetting("INSTAGRAM_AUTO_RESPOND_DMS") === "true",
      autoRespondToComments:
        this.runtime.getSetting("INSTAGRAM_AUTO_RESPOND_COMMENTS") === "true",
      pollingInterval: Number.parseInt(String(pollingIntervalStr ?? "60"), 10),
    };

    console.log(`Instagram service initialized for @${username}`);
  }

  /**
   * Start the Instagram service
   */
  async startService(): Promise<void> {
    if (!this.instagramConfig) {
      throw new Error(
        "Instagram service not initialized. Call initialize() first.",
      );
    }

    if (this.isRunning) {
      throw new Error("Instagram service is already running");
    }

    console.log("Starting Instagram service...");

    // Login would happen here in a real implementation
    // For now, we simulate the logged-in user
    this.loggedInUser = {
      pk: 0,
      username: this.instagramConfig.username,
      isPrivate: false,
      isVerified: false,
    };

    this.isRunning = true;
    console.log(
      `Instagram service started for @${this.instagramConfig.username}`,
    );
  }

  /**
   * Stop the Instagram service
   */
  override async stop(): Promise<void> {
    console.log("Stopping Instagram service...");
    this.isRunning = false;
    this.loggedInUser = null;
    console.log("Instagram service stopped");
  }

  /**
   * Check if service is running
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get the logged-in user
   */
  getLoggedInUser(): InstagramUser | null {
    return this.loggedInUser;
  }

  /**
   * Send a direct message
   */
  async sendDirectMessage(threadId: string, text: string): Promise<string> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    if (text.length > MAX_DM_LENGTH) {
      throw new Error(
        `Message too long: ${text.length} characters (max: ${MAX_DM_LENGTH})`,
      );
    }

    // In a real implementation, this would use the Instagram API
    console.log(
      `Sending DM to thread ${threadId}: ${text.substring(0, 50)}...`,
    );

    // Simulate message ID
    const messageId = `msg_${Date.now()}`;

    return messageId;
  }

  /**
   * Reply to a message in a thread
   */
  async replyToMessage(
    threadId: string,
    _messageId: string,
    text: string,
  ): Promise<string> {
    // Instagram DMs don't have a native "reply to specific message" like Telegram
    // Just send a new message to the thread
    return this.sendDirectMessage(threadId, text);
  }

  /**
   * Post a comment on media
   */
  async postComment(mediaId: number, text: string): Promise<number> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    console.log(
      `Posting comment on media ${mediaId}: ${text.substring(0, 50)}...`,
    );

    // Simulate comment ID
    const commentId = Date.now();

    return commentId;
  }

  /**
   * Reply to a comment
   */
  async replyToComment(
    mediaId: number,
    _commentId: number,
    text: string,
  ): Promise<number> {
    // In a real implementation, this would tag the user and reply
    return this.postComment(mediaId, text);
  }

  /**
   * Like media
   */
  async likeMedia(mediaId: number): Promise<void> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    console.log(`Liking media ${mediaId}`);
  }

  /**
   * Unlike media
   */
  async unlikeMedia(mediaId: number): Promise<void> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    console.log(`Unliking media ${mediaId}`);
  }

  /**
   * Follow a user
   */
  async followUser(userId: number): Promise<void> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    console.log(`Following user ${userId}`);
  }

  /**
   * Unfollow a user
   */
  async unfollowUser(userId: number): Promise<void> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    console.log(`Unfollowing user ${userId}`);
  }

  /**
   * Get user info
   */
  async getUserInfo(userId: number): Promise<InstagramUser> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    // In a real implementation, this would fetch from Instagram API
    return {
      pk: userId,
      username: `user_${userId}`,
      isPrivate: false,
      isVerified: false,
    };
  }

  /**
   * Get user by username
   */
  async getUserByUsername(username: string): Promise<InstagramUser> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    // In a real implementation, this would fetch from Instagram API
    return {
      pk: 0,
      username,
      isPrivate: false,
      isVerified: false,
    };
  }

  /**
   * Get DM threads
   */
  async getThreads(): Promise<InstagramThread[]> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    // In a real implementation, this would fetch from Instagram API
    return [];
  }

  /**
   * Get messages in a thread
   */
  async getThreadMessages(_threadId: string): Promise<InstagramMessage[]> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    // In a real implementation, this would fetch from Instagram API
    return [];
  }

  /**
   * Get user's media
   */
  async getUserMedia(_userId: number): Promise<InstagramMedia[]> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    // In a real implementation, this would fetch from Instagram API
    return [];
  }

  /**
   * Validate configuration
   */
  validateConfig(): boolean {
    if (!this.instagramConfig) {
      return false;
    }

    return !!(this.instagramConfig.username && this.instagramConfig.password);
  }
}

/**
 * Split a message into chunks
 */
export function splitMessage(content: string, maxLength: number): string[] {
  if (content.length <= maxLength) {
    return [content];
  }

  const parts: string[] = [];
  let current = "";

  for (const line of content.split("\n")) {
    const lineWithNewline = current ? `\n${line}` : line;

    if (current.length + lineWithNewline.length > maxLength) {
      if (current) {
        parts.push(current);
        current = "";
      }

      if (line.length > maxLength) {
        // Split by words
        const words = line.split(/\s+/);
        for (const word of words) {
          const wordWithSpace = current ? ` ${word}` : word;

          if (current.length + wordWithSpace.length > maxLength) {
            if (current) {
              parts.push(current);
              current = "";
            }

            if (word.length > maxLength) {
              // Split by characters
              for (let i = 0; i < word.length; i += maxLength) {
                parts.push(word.slice(i, i + maxLength));
              }
            } else {
              current = word;
            }
          } else {
            current += wordWithSpace;
          }
        }
      } else {
        current = line;
      }
    } else {
      current += lineWithNewline;
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}
