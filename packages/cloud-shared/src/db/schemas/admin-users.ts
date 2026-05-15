import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { boolean, index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Admin role enum for different permission levels
 */
export const adminRoleEnum = pgEnum("admin_role", [
  "super_admin", // Can manage other admins
  "moderator", // Can moderate users and content
  "viewer", // Read-only access to admin panel
]);

/**
 * Admin users table schema.
 *
 * Stores admin privileges for users. Admins are identified by wallet address.
 * The default anvil wallet (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266) is auto-admin in devnet.
 */
export const adminUsers = pgTable(
  "admin_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Link to user (can be null if promoting wallet before user signs up)
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),

    // Wallet address for identification
    walletAddress: text("wallet_address").notNull().unique(),

    // Admin role
    role: adminRoleEnum("role").notNull().default("moderator"),

    // Who granted admin privileges
    grantedBy: uuid("granted_by").references(() => users.id),
    grantedByWallet: text("granted_by_wallet"),

    // Status
    isActive: boolean("is_active").notNull().default(true),

    // Notes (reason for granting/revoking)
    notes: text("notes"),

    // Lifecycle
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => ({
    walletAddressIdx: index("admin_users_wallet_address_idx").on(table.walletAddress),
    userIdIdx: index("admin_users_user_id_idx").on(table.userId),
    roleIdx: index("admin_users_role_idx").on(table.role),
    isActiveIdx: index("admin_users_is_active_idx").on(table.isActive),
  }),
);

export type AdminUser = InferSelectModel<typeof adminUsers>;
export type NewAdminUser = InferInsertModel<typeof adminUsers>;
