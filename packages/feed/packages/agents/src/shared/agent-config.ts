/**
 * Agent Config Helper
 *
 * Utility functions for accessing agent configuration from the UserAgentConfig table.
 * This replaces direct access to agent fields that were previously on the User table.
 */

import {
  db,
  eq,
  type User,
  type UserAgentConfig,
  userAgentConfigs,
  users,
} from '@feed/db';
import { generateSnowflakeId } from './snowflake';

/** User with agent configuration attached */
export type UserWithAgentConfig = User & {
  agentConfig: UserAgentConfig | null;
};

/**
 * Get agent config for a user
 */
async function fetchAgentConfig(
  userId: string
): Promise<UserAgentConfig | null> {
  const result = await db
    .select()
    .from(userAgentConfigs)
    .where(eq(userAgentConfigs.userId, userId))
    .limit(1);
  return result[0] ?? null;
}

export async function getAgentConfig(
  userId: string
): Promise<UserAgentConfig | null> {
  const existing = await fetchAgentConfig(userId);
  if (existing) return existing;

  const [user] = await db
    .select({ id: users.id, isAgent: users.isAgent })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user?.isAgent) return null;

  const now = new Date();
  const [created] = await db
    .insert(userAgentConfigs)
    .values({
      id: await generateSnowflakeId(),
      userId,
      // Explicit true ensures agents trade by default regardless of DB migration state
      autonomousTrading: true,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: userAgentConfigs.userId })
    .returning();

  if (created) return created;

  return await fetchAgentConfig(userId);
}

/**
 * Get user with their agent config
 */
export async function getUserWithAgentConfig(
  userId: string
): Promise<UserWithAgentConfig | null> {
  const userResult = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const user = userResult[0];
  if (!user) return null;

  const config = await getAgentConfig(userId);
  return { ...user, agentConfig: config };
}

/**
 * Get multiple users with their agent configs
 */
export async function getUsersWithAgentConfigs(
  userIds: string[]
): Promise<UserWithAgentConfig[]> {
  if (userIds.length === 0) return [];

  const results = await Promise.all(
    userIds.map((id) => getUserWithAgentConfig(id))
  );

  return results.filter((r): r is UserWithAgentConfig => r !== null);
}

/**
 * Create or update agent config
 */
export async function upsertAgentConfig(
  userId: string,
  config: Partial<Omit<UserAgentConfig, 'id' | 'userId' | 'createdAt'>>
): Promise<UserAgentConfig> {
  const existing = await getAgentConfig(userId);

  if (existing) {
    const result = await db
      .update(userAgentConfigs)
      .set({
        ...config,
        updatedAt: new Date(),
      })
      .where(eq(userAgentConfigs.userId, userId))
      .returning();
    return result[0]!;
  }

  // Generate a new ID using snowflake for consistency
  const id = await generateSnowflakeId();
  const now = new Date();
  const result = await db
    .insert(userAgentConfigs)
    .values({
      id,
      userId,
      ...config,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return result[0]!;
}

// Legacy config helpers (getSystemPrompt, getStyle, getMessageExamples, etc.) removed.
// Access config fields directly: config?.systemPrompt, config?.style, etc.

/**
 * Helper to check if autonomous trading is enabled
 * Defaults to true to match database schema (autonomousTrading defaults to true)
 */
export function isAutonomousTradingEnabled(
  config: UserAgentConfig | null
): boolean {
  // Note: Database schema defaults autonomousTrading to true for new agents
  // When config is null (no config exists), we default to false (agent not set up)
  // When config exists but autonomousTrading is null/undefined (legacy), default to true
  if (!config) return false;
  return config.autonomousTrading ?? true;
}

/**
 * Helper to check if autonomous posting is enabled
 */
export function isAutonomousPostingEnabled(
  config: UserAgentConfig | null
): boolean {
  return config?.autonomousPosting ?? false;
}

/**
 * Helper to check if autonomous commenting is enabled
 */
export function isAutonomousCommentingEnabled(
  config: UserAgentConfig | null
): boolean {
  return config?.autonomousCommenting ?? false;
}

/**
 * Helper to check if autonomous DMs are enabled
 */
export function isAutonomousDMsEnabled(
  config: UserAgentConfig | null
): boolean {
  return config?.autonomousDMs ?? false;
}

/**
 * Helper to check if autonomous group chats are enabled
 */
export function isAutonomousGroupChatsEnabled(
  config: UserAgentConfig | null
): boolean {
  return config?.autonomousGroupChats ?? false;
}

/**
 * Helper to check if autonomous transfers are enabled
 */
export function isAutonomousTransfersEnabled(
  config: UserAgentConfig | null
): boolean {
  return config?.autonomousTransfers ?? false;
}

/**
 * Get all autonomous feature flags with proper defaults
 * Trading defaults to true, all others default to false
 */
export function getAutonomousFeatures(config: UserAgentConfig | null) {
  return {
    trading: isAutonomousTradingEnabled(config),
    posting: isAutonomousPostingEnabled(config),
    commenting: isAutonomousCommentingEnabled(config),
    dms: isAutonomousDMsEnabled(config),
    groupChats: isAutonomousGroupChatsEnabled(config),
    transfers: isAutonomousTransfersEnabled(config),
  };
}

/**
 * Check if any autonomous feature is enabled
 */
export function hasAnyAutonomousFeature(
  config: UserAgentConfig | null
): boolean {
  const features = getAutonomousFeatures(config);
  return (
    features.trading ||
    features.posting ||
    features.commenting ||
    features.dms ||
    features.groupChats ||
    features.transfers
  );
}

/**
 * Helper to get model tier from config
 */
export function getModelTier(config: UserAgentConfig | null): string {
  return config?.modelTier ?? 'free';
}

export function getAlignment(
  config: UserAgentConfig | null
): 'good' | 'neutral' | 'evil' {
  const val = config?.alignment;
  if (val === 'good' || val === 'evil') return val;
  return 'neutral';
}

export function getTeam(
  config: UserAgentConfig | null
): 'red' | 'blue' | 'gray' {
  const val = config?.team;
  if (val === 'red' || val === 'blue') return val;
  return 'gray';
}
