/**
 * Group System Types
 *
 * Shared types for the tiered group system.
 */

/**
 * Tier levels for NPC groups.
 * - Tier 1 (Inner Circle): Exclusive, full alpha
 * - Tier 2 (Community): Medium engagement, partial alpha
 * - Tier 3 (Followers): Low barrier, public content
 */
export type TierLevel = 1 | 2 | 3;

/**
 * Alpha content level corresponding to each tier.
 */
export type AlphaLevel = "full" | "partial" | "public";
