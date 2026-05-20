import { relations } from 'drizzle-orm';
import {
  decimal,
  doublePrecision,
  index,
  integer,
  json,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { JsonValue } from '../types';
import { users } from './users';

/**
 * Admin role types for RBAC
 * - SUPER_ADMIN: Full access, can manage other admins
 * - ADMIN: Can view all stats and perform admin actions
 * - VIEWER: Read-only access to admin dashboards
 */
export const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN', 'VIEWER'] as const;
export type AdminRoleType = (typeof ADMIN_ROLES)[number];

/**
 * Admin permissions for granular access control
 */
export const ADMIN_PERMISSIONS = [
  'view_stats',
  'view_users',
  'manage_users',
  'view_trading',
  'view_system',
  'give_feedback',
  'manage_admins',
  'manage_game',
  'view_reports',
  'resolve_reports',
  'manage_escrow',
  'view_alpha_groups',
  'manage_alpha_groups',
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/**
 * Default permissions by role
 *
 * SUPER_ADMIN: Full access - can manage admins, escrow, and game controls
 * ADMIN: Standard admin - can view everything, manage users/reports, but NOT escrow/game/admins
 * VIEWER: Read-only access to dashboards
 */
export const ROLE_PERMISSIONS: Record<AdminRoleType, AdminPermission[]> = {
  SUPER_ADMIN: [...ADMIN_PERMISSIONS],
  ADMIN: [
    'view_stats',
    'view_users',
    'manage_users',
    'view_trading',
    'view_system',
    'give_feedback',
    'view_reports',
    'resolve_reports',
    'view_alpha_groups',
    'manage_alpha_groups',
    // NOTE: manage_game, manage_escrow, manage_admins are SUPER_ADMIN only
  ],
  VIEWER: [
    'view_stats',
    'view_users',
    'view_trading',
    'view_system',
    'view_alpha_groups',
  ],
};

/**
 * AdminRole table - Stores admin role assignments for RBAC
 *
 * This table implements role-based access control for the admin panel,
 * replacing the simple isAdmin boolean with a more granular system.
 */
export const adminRoles = pgTable(
  'AdminRole',
  {
    id: text('id').primaryKey(),
    userId: text('userId')
      .notNull()
      .unique()
      .references(() => users.id),
    role: text('role').notNull().$type<AdminRoleType>(),
    permissions: text('permissions').array().$type<AdminPermission[]>(),
    grantedBy: text('grantedBy')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    grantedAt: timestamp('grantedAt', { mode: 'date' }).notNull().defaultNow(),
    revokedAt: timestamp('revokedAt', { mode: 'date' }),
  },
  (table) => [
    index('AdminRole_role_idx').on(table.role),
    index('AdminRole_userId_idx').on(table.userId),
    index('AdminRole_grantedAt_idx').on(table.grantedAt),
    index('AdminRole_revokedAt_idx').on(table.revokedAt),
  ]
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
    relationName: 'AdminRole_grantedByToUser',
  }),
}));

// Type exports
export type AdminRole = typeof adminRoles.$inferSelect;
export type NewAdminRole = typeof adminRoles.$inferInsert;

/**
 * SystemMetricsSnapshot - Hourly platform metrics snapshots
 *
 * Stores aggregated metrics every hour for efficient time-series queries.
 * Complements AnalyticsDailySnapshot (daily) with finer granularity
 * and additional system health metrics.
 *
 * Used by:
 * - GET /api/admin/stats/timeseries - Returns historical metrics
 * - POST /api/cron/metrics-snapshot - Creates hourly snapshots
 *
 * Retention strategy: Keep 90 days of hourly data, then aggregate to daily.
 */
export const systemMetricsSnapshots = pgTable(
  'SystemMetricsSnapshot',
  {
    id: text('id').primaryKey(),
    timestamp: timestamp('timestamp', { mode: 'date' }).notNull(),
    environment: text('environment').notNull(), // 'production' | 'staging' | 'development'

    // ===============================
    // User Metrics
    // ===============================
    totalUsers: integer('totalUsers').notNull(),
    activeUsers: integer('activeUsers').notNull(), // Active in last 24h (posted, commented, or traded)
    newSignups: integer('newSignups').notNull(), // New since last snapshot

    // ===============================
    // Trading Metrics (Prediction Markets)
    // ===============================
    tradingVolume: decimal('tradingVolume', {
      precision: 18,
      scale: 2,
    }).notNull(),
    activeMarkets: integer('activeMarkets').notNull(),
    openPositions: integer('openPositions').notNull(),

    // ===============================
    // Trading Metrics (Perpetuals)
    // ===============================
    perpVolume: decimal('perpVolume', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),
    activePerpPositions: integer('activePerpPositions').notNull().default(0),

    // ===============================
    // Social Metrics
    // ===============================
    postsCreated: integer('postsCreated').notNull().default(0), // Since last snapshot
    commentsCreated: integer('commentsCreated').notNull().default(0),
    reactionsCreated: integer('reactionsCreated').notNull().default(0),

    // ===============================
    // Financial Metrics
    // ===============================
    totalVirtualBalance: decimal('totalVirtualBalance', {
      precision: 20,
      scale: 2,
    }).notNull(),
    feesCollectedHourly: decimal('feesCollectedHourly', {
      precision: 18,
      scale: 2,
    }).notNull(),

    // ===============================
    // System Health Metrics
    // ===============================
    // Legacy field name: apiUptime stores a point-in-time database health check.
    // 100.0 = database responding, 0.0 = database unreachable.
    // For true uptime monitoring, integrate with external APM (e.g., Vercel Analytics).
    apiUptime: doublePrecision('apiUptime').notNull(),
    // Legacy field name: avgResponseTime stores DB ping latency in milliseconds.
    avgResponseTime: doublePrecision('avgResponseTime').notNull(),
    // Legacy field name: errorRate stores cron failure rate (100 - overallSuccessRate).
    errorRate: doublePrecision('errorRate').notNull(),

    // ===============================
    // Cron Job Health
    // ===============================
    cronJobsHealthy: integer('cronJobsHealthy').notNull().default(0),
    cronJobsUnhealthy: integer('cronJobsUnhealthy').notNull().default(0),

    // ===============================
    // Extended Metrics (JSON for flexibility)
    // ===============================
    extendedMetrics: json('extendedMetrics').$type<JsonValue>(),

    // ===============================
    // Metadata
    // ===============================
    snapshotDurationMs: integer('snapshotDurationMs').notNull(), // How long snapshot took
    createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    // Unique constraint: one snapshot per hour per environment (prevents duplicates)
    uniqueIndex('SystemMetricsSnapshot_timestamp_environment_unique_idx').on(
      table.timestamp,
      table.environment
    ),
    // Time range queries for single environment (environment first for filtering)
    index('SystemMetricsSnapshot_environment_timestamp_idx').on(
      table.environment,
      table.timestamp
    ),
    // Cleanup/retention queries
    index('SystemMetricsSnapshot_createdAt_idx').on(table.createdAt),
  ]
);

export type SystemMetricsSnapshot = typeof systemMetricsSnapshots.$inferSelect;
export type NewSystemMetricsSnapshot =
  typeof systemMetricsSnapshots.$inferInsert;
