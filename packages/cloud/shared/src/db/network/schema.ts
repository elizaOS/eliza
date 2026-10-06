/**
 * Typed Drizzle view of the `network` Postgres schema created by
 * `migrations/0474_network_core.sql`. Kept out of `db/schemas/index.ts` on
 * purpose: drizzle-kit generates only the `public` schema, and these tables are
 * owned by hand-written SQL on the canonical ledger (the `todos` precedent).
 */

import { sql } from "drizzle-orm";
import { bigserial, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const networkSchema = pgSchema("network");

export const networkMembers = networkSchema.table("members", {
  id: uuid("id").primaryKey().defaultRandom(),
  phoneE164: text("phone_e164").notNull(),
  cloudUserId: uuid("cloud_user_id"),
  organizationId: uuid("organization_id"),
  firstName: text("first_name"),
  city: text("city"),
  state: text("state").default("open").notNull(),
  pausedUntil: timestamp("paused_until", { withTimezone: true }),
  facets: text("facets").array().default(sql`'{}'::text[]`).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
});

export const networkInvites = networkSchema.table("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  phoneE164: text("phone_e164").notNull(),
  tokenHash: text("token_hash").notNull(),
  status: text("status").default("pending").notNull(),
  invitedByMemberId: uuid("invited_by_member_id"),
  acceptedMemberId: uuid("accepted_member_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
});

export const networkConsentLedger = networkSchema.table("consent_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  channel: text("channel").notNull(),
  address: text("address").notNull(),
  state: text("state").notNull(),
  source: text("source").notNull(),
  providerMessageId: text("provider_message_id"),
  wording: text("wording"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).default(sql`now()`).notNull(),
});

export const networkMemberEvents = networkSchema.table("member_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  memberId: uuid("member_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
});

export const networkMemberSignals = networkSchema.table("member_signals", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  memberId: uuid("member_id").notNull(),
  messageId: text("message_id").notNull(),
  kind: text("kind").notNull(),
  evidence: text("evidence").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
});
