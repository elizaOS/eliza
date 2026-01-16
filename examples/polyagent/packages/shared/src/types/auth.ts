/**
 * Authentication Types
 *
 * Shared types for authentication and user management
 */

/**
 * Authenticated user information
 *
 * @description Contains information about an authenticated user, including
 * user IDs, wallet address, and whether the user is an agent.
 */
export interface AuthenticatedUser {
  userId: string;
  dbUserId?: string;
  privyId?: string;
  walletAddress?: string;
  email?: string;
  isAgent?: boolean;
}
