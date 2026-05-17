import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Secret ballots (Wave G).
 *
 * M-of-N secret voting primitive. An agent creates a ballot with a fixed
 * participant list and a threshold. Each participant receives a per-ballot
 * scoped token (32 bytes random; sha256-hashed at rest). Submitting a vote
 * is gated on that token; replay with the same value is idempotent.
 *
 * v1: `value_ciphertext` is base64-encoded plaintext and the server tallies
 * directly. Wave H+ adds Shamir-shared shares stored in the same column with
 * no schema change.
 */
export const SECRET_BALLOT_STATUSES = ["open", "tallied", "expired", "canceled"] as const;
export type SecretBallotStatus = (typeof SECRET_BALLOT_STATUSES)[number];

export const SECRET_BALLOT_EVENT_NAMES = [
  "ballot.created",
  "ballot.distributed",
  "ballot.vote_recorded",
  "ballot.vote_rejected",
  "ballot.tallied",
  "ballot.expired",
  "ballot.canceled",
] as const;
export type SecretBallotEventName = (typeof SECRET_BALLOT_EVENT_NAMES)[number];

export interface SecretBallotParticipant {
  identityId: string;
  label?: string;
  /** Channel hint used by DISTRIBUTE_BALLOT to address the participant. */
  channelHint?: string;
}

export interface SecretBallotTallyResult {
  threshold: number;
  totalVotes: number;
  values: string[];
  /** Counts for repeat-value tallies. Keys are decoded plaintext values. */
  counts: Record<string, number>;
  tallySchemaVersion: 1;
  tallyMethod: "plaintext_v1";
}

export const secretBallots = pgTable(
  "secret_ballots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agent_id: uuid("agent_id"),
    purpose: text("purpose").notNull(),
    participants: jsonb("participants").$type<SecretBallotParticipant[]>().notNull().default([]),
    threshold: integer("threshold").notNull(),
    status: text("status").$type<SecretBallotStatus>().notNull().default("open"),
    tally_result: jsonb("tally_result").$type<SecretBallotTallyResult>(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => ({
    org_created_idx: index("secret_ballots_org_created_idx").on(
      table.organization_id,
      table.created_at,
    ),
    status_expires_idx: index("secret_ballots_status_expires_idx").on(
      table.status,
      table.expires_at,
    ),
    agent_idx: index("secret_ballots_agent_idx").on(table.agent_id),
    threshold_check: check("secret_ballots_threshold_positive", sql`${table.threshold} >= 1`),
  }),
);

export const secretBallotVotes = pgTable(
  "secret_ballot_votes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ballot_id: uuid("ballot_id")
      .notNull()
      .references(() => secretBallots.id, { onDelete: "cascade" }),
    participant_token_hash: text("participant_token_hash").notNull(),
    participant_identity_id: text("participant_identity_id").notNull(),
    value_ciphertext: text("value_ciphertext").notNull(),
    recorded_at: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ballot_identity_unique: uniqueIndex("secret_ballot_votes_ballot_identity_unique").on(
      table.ballot_id,
      table.participant_identity_id,
    ),
    ballot_token_unique: uniqueIndex("secret_ballot_votes_ballot_token_unique").on(
      table.ballot_id,
      table.participant_token_hash,
    ),
    ballot_idx: index("secret_ballot_votes_ballot_idx").on(table.ballot_id),
  }),
);

export const secretBallotEvents = pgTable(
  "secret_ballot_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ballot_id: uuid("ballot_id")
      .notNull()
      .references(() => secretBallots.id, { onDelete: "cascade" }),
    event_name: text("event_name").$type<SecretBallotEventName>().notNull(),
    redacted_payload: jsonb("redacted_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    occurred_at: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ballot_occurred_idx: index("secret_ballot_events_ballot_occurred_idx").on(
      table.ballot_id,
      table.occurred_at,
    ),
  }),
);

export type SecretBallotRow = InferSelectModel<typeof secretBallots>;
export type NewSecretBallot = InferInsertModel<typeof secretBallots>;
export type SecretBallotVoteRow = InferSelectModel<typeof secretBallotVotes>;
export type NewSecretBallotVote = InferInsertModel<typeof secretBallotVotes>;
export type SecretBallotEventRow = InferSelectModel<typeof secretBallotEvents>;
export type NewSecretBallotEvent = InferInsertModel<typeof secretBallotEvents>;
