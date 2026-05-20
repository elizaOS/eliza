/**
 * Authentication Helper for Load Testing
 *
 * Creates test user and generates auth tokens for load testing
 */

import { db, inArray, users } from '@babylon/db';
import { generateSnowflakeId } from '@babylon/shared';

export interface TestUser {
  userId: string;
  username: string;
  authToken: string;
}

/**
 * Create a test user for load testing
 * Returns user ID and a mock auth token
 */
export async function createTestUser(username: string): Promise<TestUser> {
  const userId = await generateSnowflakeId();

  // Create user in database using native Drizzle
  await db.insert(users).values({
    id: userId,
    username,
    displayName: `Load Test User ${username}`,
    bio: 'Automated load test user',
    virtualBalance: '10000',
    reputationPoints: 1000,
    updatedAt: new Date(),
    profileComplete: true,
    isTest: true, // Mark as test user to exclude from public feed
  });

  // For load testing, we'll use a simple mock token
  // In production, this would come from Privy
  const authToken = `test-token-${userId}`;

  return {
    userId,
    username,
    authToken,
  };
}

/**
 * Create multiple test users for load testing
 */
export async function createTestUsers(count: number): Promise<TestUser[]> {
  const testUsers: TestUser[] = [];

  for (let i = 0; i < count; i++) {
    const username = `loadtest_user_${Date.now()}_${i}`;
    const user = await createTestUser(username);
    testUsers.push(user);
  }

  return testUsers;
}

/**
 * Clean up test users after load testing
 */
export async function cleanupTestUsers(usernames: string[]): Promise<void> {
  await db.delete(users).where(inArray(users.username, usernames));
}
