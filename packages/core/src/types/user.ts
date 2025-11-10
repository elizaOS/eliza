import type { UUID } from './primitives';

/**
 * User record for authentication.
 *
 * Used when ENABLE_DATA_ISOLATION=true and JWT_SECRET is configured.
 * Represents a registered user account with authentication credentials.
 *
 * Note: A user is an entity - user.id corresponds to an entityId in the entities table.
 */
export interface User {
  /** Unique identifier (also serves as entityId) */
  id: UUID;

  /** User's email address (unique, used for login) */
  email: string;

  /** Username (display name) */
  username: string;

  /** Bcrypt hashed password */
  passwordHash: string;

  /** Account creation timestamp */
  createdAt?: Date;

  /** Last account update timestamp */
  updatedAt?: Date;

  /** Last successful login timestamp */
  lastLoginAt?: Date | null;
}