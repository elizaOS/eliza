import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Price modifier applied from narrative events.
 * Note: Dates stored as ISO strings for JSONB compatibility.
 *
 * @remarks
 * Bounds and semantics for numeric fields:
 * - `effect`: A price multiplier. Expected range is constrained at runtime
 *   between MIN_PRICE_MULTIPLIER (e.g., 0.5) and MAX_PRICE_MULTIPLIER (e.g., 2.0).
 *   Values below 1.0 decrease price, above 1.0 increase price (e.g., 1.05 = +5%).
 * - `decayRate`: Non-negative per-hour decay rate. Typically 0.0 to 1.0,
 *   where 0.0 means no decay and 1.0 means full decay per hour.
 *   Expected to be constrained by runtime logic to reasonable limits.
 *
 * See tests for MIN_PRICE_MULTIPLIER and MAX_PRICE_MULTIPLIER constants.
 */
export interface PriceModifier {
  eventId: string;
  /**
   * Price multiplier effect. Constrained between MIN_PRICE_MULTIPLIER and MAX_PRICE_MULTIPLIER.
   * Values < 1.0 decrease price, > 1.0 increase price (e.g., 1.05 = +5%).
   */
  effect: number;
  /**
   * Per-hour decay rate. Non-negative value, typically 0.0 to 1.0.
   * 0.0 = no decay, 1.0 = full decay per hour.
   */
  decayRate: number;
  appliedAt: string; // ISO date string
  expiresAt: string; // ISO date string
}

/**
 * Stock fundamentals for narrative-driven pricing
 */
export interface StockFundamentals {
  basePrice: number;
  sentiment: number; // -100 to +100
  activeModifiers: PriceModifier[];
}

/**
 * OrganizationState - Dynamic runtime state for organizations
 *
 * Static organization data is in TypeScript (StaticDataRegistry from @babylon/engine).
 * This table stores only fields that change during gameplay.
 */
export const organizationState = pgTable(
  'OrganizationState',
  {
    id: text('id').primaryKey(),
    currentPrice: doublePrecision('currentPrice'),

    // Fundamentals for narrative-driven pricing
    // Default basePrice to 100.0 to ensure it's never NULL for downstream calculations
    basePrice: doublePrecision('basePrice').notNull().default(100.0),
    sentiment: integer('sentiment').notNull().default(0), // -100 to +100
    activeModifiers: jsonb('activeModifiers')
      .$type<PriceModifier[]>()
      .default(sql`'[]'::jsonb`),

    createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull(),
  },
  (table) => [
    index('OrganizationState_currentPrice_idx').on(table.currentPrice),
    index('OrganizationState_sentiment_idx').on(table.sentiment),
    // Enforce sentiment bounds at database level (-100 to +100)
    check(
      'sentiment_range',
      sql`${table.sentiment} >= -100 AND ${table.sentiment} <= 100`
    ),
  ]
);

// Type exports
export type OrganizationStateRow = typeof organizationState.$inferSelect;
export type NewOrganizationStateRow = typeof organizationState.$inferInsert;
