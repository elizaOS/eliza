import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Users table for JWT authentication.
 *
 * Stores registered users with authentication credentials.
 * Only required when using custom auth mode (JWT_SECRET).
 * Not needed when using external providers (Privy, CDP, Auth0).
 *
 * Note: user.id matches entityId in entities table - a user IS an entity.
 */
export const userTable = pgTable(
  'users',
  {
    id: uuid('id')
      .notNull()
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    email: text('email')
      .notNull()
      .unique(),

    username: text('username')
      .notNull(),

    passwordHash: text('password_hash')
      .notNull(),

    createdAt: timestamp('created_at')
      .default(sql`now()`)
      .notNull(),

    updatedAt: timestamp('updated_at')
      .default(sql`now()`)
      .notNull(),

    lastLoginAt: timestamp('last_login_at'),
  },
  (table) => ({
    emailIdx: index('idx_users_email').on(table.email),
    usernameIdx: index('idx_users_username').on(table.username),
  })
);