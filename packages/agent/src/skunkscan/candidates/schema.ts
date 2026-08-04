/**
 * Persistence for SkunkScan's scam-pattern candidate list: wallets whose
 * on-chain behavior automatically matched a known scam signature (e.g.
 * "raise-and-drain"), surfaced for a human reviewer to accept or reject -
 * never auto-labeled, never added to the exposure registry on their own.
 *
 * Lives under a dedicated `skunkscan` Postgres schema (mirroring the
 * runtime's `app_lifeops` schema for the knowledge graph) rather than the
 * public schema, since this is SkunkScan-specific data that may grow to
 * cover more than just candidate matches over time.
 *
 * Scope note: this is deliberately narrower than a general
 * investigation-results store (investigations/repository.ts remains an
 * unimplemented interface, out of scope here) - only what candidate
 * detection itself needs.
 */

import {
  boolean,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const skunkscanPgSchema = pgSchema("skunkscan");

export const scamPatternCandidates = skunkscanPgSchema.table(
  "scam_pattern_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    chain: text("chain").notNull(),
    address: text("address").notNull(),

    // Which pattern(s) matched, e.g. ["raise_and_drain"] - a string array
    // rather than one row per pattern, since a single wallet can trip more
    // than one pattern and a reviewer wants to see all of them together.
    patterns: jsonb("patterns").notNull(),

    // Pattern-specific structured evidence (amounts, dates, tx signatures) -
    // shaped per pattern type, see patterns/raiseAndDrain.ts's
    // RaiseAndDrainEvidence for the current (only) pattern's shape.
    evidence: jsonb("evidence").notNull(),

    // Whether the wallet itself, or any of the counterparties feeding the
    // match, are already in the label registry (e.g. a known exchange) -
    // surfaced prominently so a reviewer sees "this is Binance 14" before
    // anything else, guarding against the CEX-hot-wallet false positive.
    hasKnownLabelMatch: boolean("has_known_label_match").notNull().default(false),
    labelMatches: jsonb("label_matches").notNull().default(sql`'[]'::jsonb`),

    // "pending" | "accepted" | "rejected" - validated in application code
    // (candidates/types.ts), not a DB check constraint, matching this
    // codebase's existing convention (see approval/store.ts) of enumerating
    // legal values/transitions in code rather than relying on the database
    // to enforce them.
    reviewStatus: text("review_status").notNull().default("pending"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNotes: text("review_notes"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One candidate row per wallet - re-detection is a future upsert
    // concern (out of scope for this first pass), the constraint just
    // prevents accidental duplicate inserts for the same address today.
    unique().on(t.chain, t.address),
  ],
);

export const scamPatternCandidatesSchema = { scamPatternCandidates } as const;
