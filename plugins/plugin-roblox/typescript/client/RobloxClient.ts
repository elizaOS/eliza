/**
 * Roblox Open Cloud API Client
 *
 * Provides methods for interacting with Roblox's Open Cloud APIs including:
 * - Messaging Service (cross-server communication)
 * - DataStore (persistent data storage)
 * - User information lookup
 */

import type {
  RobloxConfig,
  RobloxUser,
  RobloxExperienceInfo,
  RobloxServerInfo,
  DataStoreEntry,
  MessagingServiceMessage,
} from "../types";

const ROBLOX_API_BASE = "https://apis.roblox.com";
const USERS_API_BASE = "https://users.roblox.com";

/**
 * Error thrown by Roblox API operations
 */
export class RobloxApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public endpoint: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "RobloxApiError";
  }
}

/**
 * Roblox Open Cloud API Client
 */
export class RobloxClient {
  private config: RobloxConfig;

  constructor(config: RobloxConfig) {
    this.config = config;
  }

  /**
   * Make an authenticated request to the Roblox Open Cloud API
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    baseUrl: string = ROBLOX_API_BASE
  ): Promise<T> {
    const url = `${baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      "x-api-key": this.config.apiKey,
      "Content-Type": "application/json",
      ...((options.headers as Record<string, string>) || {}),
    };

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      let details: unknown;
      try {
        details = await response.json();
      } catch {
        details = await response.text();
      }
      throw new RobloxApiError(
        `Roblox API error: ${response.statusText}`,
        response.status,
        endpoint,
        details
      );
    }

    // Handle empty responses
    const text = await response.text();
    if (!text) {
      return {} as T;
    }

    return JSON.parse(text) as T;
  }

  // ==================== Messaging Service ====================

  /**
   * Publish a message to a topic via the Messaging Service
   */
  async publishMessage(
    topic: string,
    data: unknown,
    universeId?: string
  ): Promise<void> {
    if (this.config.dryRun) {
      console.log(`[DRY RUN] Would publish to topic "${topic}":`, data);
      return;
    }

    const targetUniverseId = universeId || this.config.universeId;

    await this.request(
      `/messaging-service/v1/universes/${targetUniverseId}/topics/${encodeURIComponent(topic)}`,
      {
        method: "POST",
        body: JSON.stringify({ message: JSON.stringify(data) }),
      }
    );
  }

  /**
   * Send a message to the default agent topic
   */
  async sendAgentMessage(message: MessagingServiceMessage): Promise<void> {
    await this.publishMessage(this.config.messagingTopic, message);
  }

  // ==================== DataStore ====================

  /**
   * Get an entry from a DataStore
   */
  async getDataStoreEntry<T = unknown>(
    datastoreName: string,
    key: string,
    scope: string = "global"
  ): Promise<DataStoreEntry<T> | null> {
    try {
      const response = await this.request<{
        value: string;
        version: string;
        createdTime: string;
        updatedTime: string;
      }>(
        `/datastores/v1/universes/${this.config.universeId}/standard-datastores/datastore/entries/entry?datastoreName=${encodeURIComponent(datastoreName)}&scope=${encodeURIComponent(scope)}&entryKey=${encodeURIComponent(key)}`
      );

      return {
        key,
        value: JSON.parse(response.value) as T,
        version: response.version,
        createdAt: new Date(response.createdTime),
        updatedAt: new Date(response.updatedTime),
      };
    } catch (error) {
      if (error instanceof RobloxApiError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Set an entry in a DataStore
   */
  async setDataStoreEntry<T = unknown>(
    datastoreName: string,
    key: string,
    value: T,
    scope: string = "global"
  ): Promise<DataStoreEntry<T>> {
    if (this.config.dryRun) {
      console.log(`[DRY RUN] Would set DataStore entry "${key}":`, value);
      return {
        key,
        value,
        version: "dry-run",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    const response = await this.request<{
      version: string;
      createdTime: string;
      updatedTime: string;
    }>(
      `/datastores/v1/universes/${this.config.universeId}/standard-datastores/datastore/entries/entry?datastoreName=${encodeURIComponent(datastoreName)}&scope=${encodeURIComponent(scope)}&entryKey=${encodeURIComponent(key)}`,
      {
        method: "POST",
        body: JSON.stringify(value),
      }
    );

    return {
      key,
      value,
      version: response.version,
      createdAt: new Date(response.createdTime),
      updatedAt: new Date(response.updatedTime),
    };
  }

  /**
   * Delete an entry from a DataStore
   */
  async deleteDataStoreEntry(
    datastoreName: string,
    key: string,
    scope: string = "global"
  ): Promise<void> {
    if (this.config.dryRun) {
      console.log(`[DRY RUN] Would delete DataStore entry "${key}"`);
      return;
    }

    await this.request(
      `/datastores/v1/universes/${this.config.universeId}/standard-datastores/datastore/entries/entry?datastoreName=${encodeURIComponent(datastoreName)}&scope=${encodeURIComponent(scope)}&entryKey=${encodeURIComponent(key)}`,
      { method: "DELETE" }
    );
  }

  /**
   * List entries in a DataStore
   */
  async listDataStoreEntries(
    datastoreName: string,
    scope: string = "global",
    prefix?: string,
    limit: number = 100
  ): Promise<{ keys: string[]; nextPageCursor?: string }> {
    let url = `/datastores/v1/universes/${this.config.universeId}/standard-datastores/datastore/entries?datastoreName=${encodeURIComponent(datastoreName)}&scope=${encodeURIComponent(scope)}&limit=${limit}`;

    if (prefix) {
      url += `&prefix=${encodeURIComponent(prefix)}`;
    }

    const response = await this.request<{
      keys: Array<{ key: string }>;
      nextPageCursor?: string;
    }>(url);

    return {
      keys: response.keys.map((k) => k.key),
      nextPageCursor: response.nextPageCursor,
    };
  }

  // ==================== Users ====================

  /**
   * Get user information by user ID
   */
  async getUserById(userId: number): Promise<RobloxUser> {
    const response = await this.request<{
      id: number;
      name: string;
      displayName: string;
      created: string;
      isBanned: boolean;
    }>(`/v1/users/${userId}`, {}, USERS_API_BASE);

    return {
      id: response.id,
      username: response.name,
      displayName: response.displayName,
      createdAt: new Date(response.created),
      isBanned: response.isBanned,
    };
  }

  /**
   * Get user information by username
   */
  async getUserByUsername(username: string): Promise<RobloxUser | null> {
    try {
      const response = await this.request<{
        data: Array<{
          id: number;
          name: string;
          displayName: string;
        }>;
      }>(
        `/v1/usernames/users`,
        {
          method: "POST",
          body: JSON.stringify({
            usernames: [username],
            excludeBannedUsers: false,
          }),
        },
        USERS_API_BASE
      );

      if (response.data.length === 0) {
        return null;
      }

      const user = response.data[0];
      return {
        id: user.id,
        username: user.name,
        displayName: user.displayName,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get multiple users by their IDs
   */
  async getUsersByIds(userIds: number[]): Promise<RobloxUser[]> {
    if (userIds.length === 0) {
      return [];
    }

    const response = await this.request<{
      data: Array<{
        id: number;
        name: string;
        displayName: string;
      }>;
    }>(
      `/v1/users`,
      {
        method: "POST",
        body: JSON.stringify({ userIds, excludeBannedUsers: false }),
      },
      USERS_API_BASE
    );

    return response.data.map((user) => ({
      id: user.id,
      username: user.name,
      displayName: user.displayName,
    }));
  }

  /**
   * Get avatar thumbnail URL for a user
   */
  async getAvatarUrl(
    userId: number,
    size: string = "150x150"
  ): Promise<string | undefined> {
    try {
      const response = await this.request<{
        data: Array<{ imageUrl: string }>;
      }>(
        `/v1/users/avatar-headshot?userIds=${userId}&size=${size}&format=Png`,
        {},
        "https://thumbnails.roblox.com"
      );

      return response.data[0]?.imageUrl;
    } catch {
      return undefined;
    }
  }

  // ==================== Experience Info ====================

  /**
   * Get experience/universe information
   */
  async getExperienceInfo(universeId?: string): Promise<RobloxExperienceInfo> {
    const targetUniverseId = universeId || this.config.universeId;

    const response = await this.request<{
      data: Array<{
        id: number;
        name: string;
        description: string;
        creator: {
          id: number;
          type: string;
          name: string;
        };
        playing: number;
        visits: number;
        rootPlaceId: number;
      }>;
    }>(`/v1/games?universeIds=${targetUniverseId}`, {}, "https://games.roblox.com");

    const experience = response.data[0];
    if (!experience) {
      throw new RobloxApiError(
        `Experience not found: ${targetUniverseId}`,
        404,
        `/v1/games?universeIds=${targetUniverseId}`
      );
    }

    return {
      universeId: targetUniverseId,
      name: experience.name,
      description: experience.description,
      creator: {
        id: experience.creator.id,
        type: experience.creator.type as "User" | "Group",
        name: experience.creator.name,
      },
      playing: experience.playing,
      visits: experience.visits,
      rootPlaceId: String(experience.rootPlaceId),
    };
  }

  // ==================== Configuration ====================

  /**
   * Get the current configuration
   */
  getConfig(): Readonly<RobloxConfig> {
    return { ...this.config };
  }

  /**
   * Check if dry run mode is enabled
   */
  isDryRun(): boolean {
    return this.config.dryRun;
  }
}

