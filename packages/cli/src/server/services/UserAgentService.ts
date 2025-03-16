import { v4 as uuidv4 } from 'uuid';
import type { UUID } from '@elizaos/core';
import { logger } from '@elizaos/core';
import type { Database } from '../database/Database';
import type { Agent } from '@elizaos/core';

/**
 * Service to manage user agents in the system.
 * User agents represent human users in the agent system but don't have AI capabilities.
 */
export class UserAgentService {
  private static instance: UserAgentService | null = null;

  // Map of user IDs to their agent IDs
  private userAgentMap: Map<string, UUID> = new Map();

  private constructor(private db: Database) {
    logger.info('[UserAgentService] Initializing user agent service');
  }

  /**
   * Get the singleton instance of UserAgentService
   */
  public static getInstance(db: Database): UserAgentService {
    if (!UserAgentService.instance) {
      UserAgentService.instance = new UserAgentService(db);
    }
    return UserAgentService.instance;
  }

  /**
   * Get or create a user agent for a user ID
   * @param userId The user's unique identifier
   * @param username The user's display name
   * @returns The UUID of the user's agent
   */
  public async getOrCreateUserAgent(userId: string, username: string): Promise<UUID> {
    // Check if we already have an agent for this user
    if (this.userAgentMap.has(userId)) {
      return this.userAgentMap.get(userId)!;
    }

    // Check if agent exists in database
    const agents = await this.db.getAgents();
    const existingAgent = agents.find(
      (a) => a.metadata?.isUserAgent && a.metadata.userId === userId
    );

    if (existingAgent) {
      this.userAgentMap.set(userId, existingAgent.id);
      return existingAgent.id;
    }

    // Create a new user agent
    const agentId = uuidv4() as UUID;

    const userAgent: Agent = {
      id: agentId,
      name: `User: ${username}`,
      description: `User agent for ${username}`,
      modelType: 'none', // No AI model for user agents
      settings: {},
      metadata: {
        isUserAgent: true,
        userId: userId,
        username: username,
        isEnabled: false, // User agents aren't enabled for AI responses
      },
    };

    // Save to database
    await this.db.ensureAgentExists(userAgent);
    logger.info(`[UserAgentService] Created new user agent ${agentId} for user ${userId}`);

    // Cache the mapping
    this.userAgentMap.set(userId, agentId);

    return agentId;
  }

  /**
   * Get the agent ID for a user
   * @param userId The user's unique identifier
   * @returns The UUID of the user's agent, or undefined if not found
   */
  public getUserAgentId(userId: string): UUID | undefined {
    return this.userAgentMap.get(userId);
  }

  /**
   * Check if an agent is a user agent
   * @param agentId The agent ID to check
   * @returns True if the agent is a user agent, false otherwise
   */
  public async isUserAgent(agentId: UUID): Promise<boolean> {
    const agent = await this.db.getAgent(agentId);
    return !!agent?.metadata?.isUserAgent;
  }

  /**
   * Get all user agent IDs
   * @returns Array of user agent IDs
   */
  public getUserAgentIds(): UUID[] {
    return Array.from(this.userAgentMap.values());
  }
}
