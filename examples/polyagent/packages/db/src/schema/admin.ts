import { relations } from "drizzle-orm";
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Admin role types for RBAC
 * - SUPER_ADMIN: Full access, can manage other admins
 * - ADMIN: Can view all stats and perform admin actions
 * - VIEWER: Read-only access to admin dashboards
 */
export const ADMIN_ROLES = ["SUPER_ADMIN", "ADMIN", "VIEWER"] as const;
export type AdminRoleType = (typeof ADMIN_ROLES)[number];

/**
 * Admin permissions for granular access control
 */
export const ADMIN_PERMISSIONS = [
  "view_stats",
  "view_users",
  "manage_users",
  "view_trading",
  "view_system",
  "give_feedback",
  "manage_admins",
  "manage_game",
  "view_reports",
  "resolve_reports",
  "manage_escrow",
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/**
 * Default permissions by role
 */
export const ROLE_PERMISSIONS: Record<AdminRoleType, AdminPermission[]> = {
  SUPER_ADMIN: [...ADMIN_PERMISSIONS],
  ADMIN: [
    "view_stats",
    "view_users",
    "manage_users",
    "view_trading",
    "view_system",
    "give_feedback",
    "manage_game",
    "view_reports",
    "resolve_reports",
    "manage_escrow",
  ],
  VIEWER: ["view_stats", "view_users", "view_trading", "view_system"],
};

/**
 * AdminRole table - Stores admin role assignments for RBAC
 *
 * This table implements role-based access control for the admin panel,
 * replacing the simple isAdmin boolean with a more granular system.
 */
export const adminRoles = pgTable(
  "AdminRole",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .unique()
      .references(() => users.id),
    role: text("role").notNull().$type<AdminRoleType>(),
    permissions: text("permissions").array().$type<AdminPermission[]>(),
    grantedBy: text("grantedBy")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    grantedAt: timestamp("grantedAt", { mode: "date" }).notNull().defaultNow(),
    revokedAt: timestamp("revokedAt", { mode: "date" }),
  },
  (table) => [
    index("AdminRole_role_idx").on(table.role),
    index("AdminRole_userId_idx").on(table.userId),
    index("AdminRole_grantedAt_idx").on(table.grantedAt),
    index("AdminRole_revokedAt_idx").on(table.revokedAt),
  ],
);

// Relations
export const adminRolesRelations = relations(adminRoles, ({ one }) => ({
  user: one(users, {
    fields: [adminRoles.userId],
    references: [users.id],
  }),
  granter: one(users, {
    fields: [adminRoles.grantedBy],
    references: [users.id],
    relationName: "AdminRole_grantedByToUser",
  }),
}));

// Type exports
export type AdminRole = typeof adminRoles.$inferSelect;
export type NewAdminRole = typeof adminRoles.$inferInsert;
