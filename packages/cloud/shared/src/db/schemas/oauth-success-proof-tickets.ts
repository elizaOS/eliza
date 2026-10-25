/**
 * Strongly consistent one-time tickets backing OAuth success-page proofs.
 * Nonces are stored only as SHA-256 digests and claimed atomically through
 * Postgres because the deployed Worker's cache is eventually consistent KV.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const oauthSuccessProofTickets = pgTable(
  "oauth_success_proof_tickets",
  {
    nonce_hash: text("nonce_hash").primaryKey(),
    platform: text("platform").notNull(),
    connection_id: text("connection_id"),
    organization_id: text("organization_id").notNull(),
    user_id: text("user_id").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    expiresAtIdx: index("oauth_success_proof_tickets_expires_at_idx").on(table.expires_at),
  }),
);

export type OAuthSuccessProofTicketRow = InferSelectModel<typeof oauthSuccessProofTickets>;
export type NewOAuthSuccessProofTicketRow = InferInsertModel<typeof oauthSuccessProofTickets>;
