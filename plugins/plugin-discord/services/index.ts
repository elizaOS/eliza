import { REST } from "@discordjs/rest";

/**
 * Singleton service for managing Discord REST API client
 * Handles authentication and provides a reusable REST client for all Discord tools
 */
export class DiscordService {
  private static instance: DiscordService | null = null;
  private rest: REST | null = null;
  private token: string | null = null;

  private constructor() {
    // Private constructor to enforce singleton pattern
  }

  /**
   * Get the singleton instance of DiscordService
   */
  public static getInstance(): DiscordService {
    if (!DiscordService.instance) {
      DiscordService.instance = new DiscordService();
    }
    return DiscordService.instance;
  }

  /**
   * Initialize the service with Discord token
   * Must be called before using the REST client
   */
  public initialize(token: string): void {
    if (this.rest && this.token === token) {
      // Already initialized with the same token
      return;
    }

    if (!token || token.trim() === "") {
      throw new Error("Discord API token is required");
    }

    this.token = token;
    this.rest = new REST({ version: "10" }).setToken(token);
  }

  /**
   * Get the Discord REST client
   * @throws Error if the service hasn't been initialized
   */
  public getRestClient(): REST {
    if (!this.rest) {
      throw new Error(
        "DiscordService not initialized. Call initialize(runtime) first.",
      );
    }
    return this.rest;
  }

  /**
   * Get the Discord token
   * @throws Error if the service hasn't been initialized
   */
  public getToken(): string {
    if (!this.token) {
      throw new Error(
        "DiscordService not initialized. Call initialize(token) first.",
      );
    }
    return this.token;
  }

  /**
   * Check if the service is initialized
   */
  public isInitialized(): boolean {
    return this.rest !== null && this.token !== null;
  }

  /**
   * Reset the service (useful for testing or token changes)
   */
  public reset(): void {
    this.rest = null;
    this.token = null;
  }
}

// Export singleton instance for convenience
export const discordService = DiscordService.getInstance();
