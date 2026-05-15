import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * Approval requests (Wave D).
 *
 * Atomic primitive for "approve a login" / "verify this identity" flows.
 * A challenger (agent or user) creates an approval request bound to an
 * expected signer identity; the signer interacts with the hosted approve
 * page (or DM link), signs the challenge text, and submits the signature.
 * The IdentityVerificationGatekeeper validates the signature against the
 * declared signer kind (SIWE wallet or Ed25519 device key) before binding
 * the identity to a session.
 *
 * `challenge_kind`, `status`, and `event_name` are CHECK-constrained, not pg
 * enums, so new kinds/statuses can ship without ALTER TYPE coordination.
 */
export const APPROVAL_CHALLENGE_KINDS = ["login", "signature", "generic"] as const;
export type ApprovalChallengeKind = (typeof APPROVAL_CHALLENGE_KINDS)[number];

export const APPROVAL_REQUEST_STATUSES = [
  "pending",
  "delivered",
  "approved",
  "denied",
  "expired",
  "canceled",
] as const;
export type ApprovalRequestStatus = (typeof APPROVAL_REQUEST_STATUSES)[number];

export const APPROVAL_REQUEST_EVENT_NAMES = [
  "approval.created",
  "approval.delivered",
  "approval.viewed",
  "approval.approved",
  "approval.denied",
  "approval.canceled",
  "approval.expired",
  "callback.dispatched",
  "callback.failed",
] as const;
export type ApprovalRequestEventName = (typeof APPROVAL_REQUEST_EVENT_NAMES)[number];

/**
 * Shape of the persisted challenge payload. The signer renders `message`
 * (or, for SIWE, the structured fields) and signs it. `signerKind` tells the
 * gatekeeper which verifier to run.
 */
export interface ApprovalChallengePayload {
  message?: string;
  signerKind?: "wallet" | "ed25519";
  /** For wallet (SIWE): expected EIP-55 checksummed address. */
  walletAddress?: string;
  /** For ed25519: base64 / hex encoded public key. */
  publicKey?: string;
  /** Optional context (login session id, redirect target, etc). */
  context?: Record<string, unknown>;
}

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // agent_id FK enforced in SQL (`agents(id)`); not declared here because the
    // agents table is defined in @elizaos/plugin-sql, not in the cloud schema set.
    agent_id: uuid("agent_id"),
    user_id: uuid("user_id").references(() => users.id, { onDelete: "set null" }),

    challenge_kind: text("challenge_kind").$type<ApprovalChallengeKind>().notNull(),
    challenge_payload: jsonb("challenge_payload")
      .$type<ApprovalChallengePayload>()
      .notNull()
      .default({}),

    expected_signer_identity_id: text("expected_signer_identity_id"),

    status: text("status").$type<ApprovalRequestStatus>().notNull().default("pending"),

    signature_text: text("signature_text"),
    signed_at: timestamp("signed_at", { withTimezone: true }),

    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),

    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => ({
    org_created_idx: index("idx_approval_requests_org_created").on(
      table.organization_id,
      table.created_at,
    ),
    status_expires_idx: index("idx_approval_requests_status_expires").on(
      table.status,
      table.expires_at,
    ),
    agent_idx: index("idx_approval_requests_agent").on(table.agent_id),
    expected_signer_idx: index("idx_approval_requests_expected_signer").on(
      table.expected_signer_identity_id,
    ),
    challenge_kind_check: check(
      "approval_requests_challenge_kind_check",
      sql`${table.challenge_kind} IN ('login','signature','generic')`,
    ),
    status_check: check(
      "approval_requests_status_check",
      sql`${table.status} IN ('pending','delivered','approved','denied','expired','canceled')`,
    ),
  }),
);

export const approvalRequestEvents = pgTable(
  "approval_request_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    approval_request_id: uuid("approval_request_id")
      .notNull()
      .references(() => approvalRequests.id, { onDelete: "cascade" }),
    event_name: text("event_name").$type<ApprovalRequestEventName>().notNull(),
    redacted_payload: jsonb("redacted_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    occurred_at: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    request_occurred_idx: index("idx_approval_request_events_request").on(
      table.approval_request_id,
      table.occurred_at,
    ),
    event_name_check: check(
      "approval_request_events_event_name_check",
      sql`${table.event_name} IN (
        'approval.created','approval.delivered','approval.viewed',
        'approval.approved','approval.denied','approval.canceled','approval.expired',
        'callback.dispatched','callback.failed'
      )`,
    ),
  }),
);

export type ApprovalRequestRow = InferSelectModel<typeof approvalRequests>;
export type NewApprovalRequest = InferInsertModel<typeof approvalRequests>;
export type ApprovalRequestEventRow = InferSelectModel<typeof approvalRequestEvents>;
export type NewApprovalRequestEvent = InferInsertModel<typeof approvalRequestEvents>;
