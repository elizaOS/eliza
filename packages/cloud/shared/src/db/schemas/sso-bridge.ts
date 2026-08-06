/**
 * Cross-host SSO bridge persistence: single-use handshake codes and per-user
 * explicit-logout markers. These live in Postgres — NOT the cache — because
 * the deployed Worker cache is Cloudflare KV, which is eventually consistent
 * and has no atomic operations, so it cannot guarantee either "a code is
 * consumed exactly once" or "a logout is visible immediately". Postgres gives
 * both: `DELETE … RETURNING` claims a code atomically, and marker reads are
 * read-your-writes. Rows never contain token material: codes are stored as
 * sha256 only, and the payload is the VERIFIED claims a fresh token is
 * re-minted from at exchange time (`lib/services/sso-bridge-codes.ts`).
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const ssoBridgeCodes = pgTable(
  "sso_bridge_codes",
  {
    /** sha256 hex of the full opaque code; the raw code is never stored. */
    code_hash: text("code_hash").primaryKey(),
    steward_user_id: text("steward_user_id").notNull(),
    /** sha256 hex of the exchange verifier (PKCE analog) — never the verifier. */
    code_challenge: text("code_challenge").notNull(),
    /** Verified Steward claims captured at mint; the exchange re-mints from these. */
    claims: jsonb("claims").notNull().$type<Record<string, unknown>>(),
    /** iat of the ORIGINAL session token — logout-marker ordering input. */
    token_issued_at: timestamp("token_issued_at", { withTimezone: true }).notNull(),
    /** exp of the ORIGINAL session token — the re-minted token never outlives it. */
    token_expires_at: timestamp("token_expires_at", { withTimezone: true }).notNull(),
    /** Code TTL (~60s); enforced in the claim's WHERE clause, purged opportunistically. */
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    expiresAtIdx: index("sso_bridge_codes_expires_at_idx").on(table.expires_at),
  }),
);

export const ssoBridgeLogoutMarkers = pgTable("sso_bridge_logout_markers", {
  steward_user_id: text("steward_user_id").primaryKey(),
  /** Most recent explicit logout; only ever moves forward (GREATEST on upsert). */
  logged_out_at: timestamp("logged_out_at", { withTimezone: true }).notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SsoBridgeCode = InferSelectModel<typeof ssoBridgeCodes>;
export type NewSsoBridgeCode = InferInsertModel<typeof ssoBridgeCodes>;
export type SsoBridgeLogoutMarker = InferSelectModel<typeof ssoBridgeLogoutMarkers>;
export type NewSsoBridgeLogoutMarker = InferInsertModel<typeof ssoBridgeLogoutMarkers>;
