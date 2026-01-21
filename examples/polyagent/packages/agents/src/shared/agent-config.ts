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
} from "@polyagent/db";

/** User with agent configuration attached */
export type UserWithAgentConfig = User & {
  agentConfig: UserAgentConfig | null;
};

/**
 * Get agent config for a user
 */
export async function getAgentConfig(
  userId: string,
): Promise<UserAgentConfig | null> {
  const result = await db
    .select()
    .from(userAgentConfigs)
    .where(eq(userAgentConfigs.userId, userId))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Get user with their agent config
 */
export async function getUserWithAgentConfig(
  userId: string,
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
  userIds: string[],
): Promise<UserWithAgentConfig[]> {
  if (userIds.length === 0) return [];

  const results = await Promise.all(
    userIds.map((id) => getUserWithAgentConfig(id)),
  );

  return results.filter((r): r is UserWithAgentConfig => r !== null);
}

/**
 * Create or update agent config
 */
export async function upsertAgentConfig(
  userId: string,
  config: Partial<Omit<UserAgentConfig, "id" | "userId" | "createdAt">>,
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

  // Generate a new ID
  const id = `uac_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const result = await db
    .insert(userAgentConfigs)
    .values({
      id,
      userId,
      ...config,
      updatedAt: new Date(),
    })
    .returning();

  return result[0]!;
}

/**
 * Helper to get system prompt from agent config or user personality
 */
export function getSystemPrompt(
  user: User,
  config: UserAgentConfig | null,
): string | null {
  // systemPrompt is stored in the 'system' column in the database
  return config?.systemPrompt ?? user.personality ?? null;
}

/**
 * Get style from config
 */
export function getStyle(config: UserAgentConfig | null): string[] {
  if (!config?.style) return [];
  const style = config.style as { all?: string[] };
  return style?.all ?? [];
}

/**
 * Get message examples from config
 */
export function getMessageExamples(
  config: UserAgentConfig | null,
): Array<Array<{ user: string; content: { text: string } }>> {
  if (!config?.messageExamples) return [];
  return config.messageExamples as Array<
    Array<{ user: string; content: { text: string } }>
  >;
}

/**
 * Get trading strategy from config
 */
export function getTradingStrategy(
  config: UserAgentConfig | null,
): string | null {
  return config?.tradingStrategy ?? null;
}

/**
 * Get directives from config
 */
export function getDirectives(config: UserAgentConfig | null): string[] {
  if (!config?.directives) return [];
  return config.directives as string[];
}

/**
 * Get constraints from config
 */
export function getConstraints(config: UserAgentConfig | null): string[] {
  if (!config?.constraints) return [];
  return config.constraints as string[];
}

/**
 * Get max actions per tick from config
 */
export function getMaxActionsPerTick(config: UserAgentConfig | null): number {
  return config?.maxActionsPerTick ?? 3;
}

/**
 * Get risk tolerance from config
 */
export function getRiskTolerance(config: UserAgentConfig | null): string {
  return config?.riskTolerance ?? "medium";
}

/**
 * Get planning horizon from config
 */
export function getPlanningHorizon(config: UserAgentConfig | null): string {
  return config?.planningHorizon ?? "single";
}

/**
 * Helper to check if autonomous trading is enabled
 */
export function isAutonomousTradingEnabled(
  config: UserAgentConfig | null,
): boolean {
  return config?.autonomousTrading ?? false;
}

/**
 * Helper to check if autonomous posting is enabled
 */
export function isAutonomousPostingEnabled(
  config: UserAgentConfig | null,
): boolean {
  return config?.autonomousPosting ?? false;
}

/**
 * Helper to check if autonomous commenting is enabled
 */
export function isAutonomousCommentingEnabled(
  config: UserAgentConfig | null,
): boolean {
  return config?.autonomousCommenting ?? false;
}

/**
 * Helper to check if autonomous DMs are enabled
 */
export function isAutonomousDMsEnabled(
  config: UserAgentConfig | null,
): boolean {
  return config?.autonomousDMs ?? false;
}

/**
 * Helper to check if autonomous group chats are enabled
 */
export function isAutonomousGroupChatsEnabled(
  config: UserAgentConfig | null,
): boolean {
  return config?.autonomousGroupChats ?? false;
}

/**
 * Helper to get model tier from config
 */
export function getModelTier(config: UserAgentConfig | null): string {
  return config?.modelTier ?? "free";
}
