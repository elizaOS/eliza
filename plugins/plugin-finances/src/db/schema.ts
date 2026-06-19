/**
 * Drizzle schema for @elizaos/plugin-finances.
 *
 * Tables live in their own pgSchema("app_finances") namespace. The five
 * finance tables below were carved out of @elizaos/plugin-personal-assistant
 * (formerly in app_lifeops); table NAMES are preserved verbatim
 * (life_payment_*, life_subscription_*) so a non-destructive copy migration can
 * move existing rows across schemas. All raw SQL that targets these tables must
 * qualify them with the `app_finances.` prefix.
 */

import {
  boolean,
  integer,
  pgSchema,
  real,
  text,
  unique,
} from "drizzle-orm/pg-core";

export const financesSchema = pgSchema("app_finances");

export const lifeSubscriptionAudits = financesSchema.table(
  "life_subscription_audits",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    source: text("source").notNull().default("gmail"),
    queryWindowDays: integer("query_window_days").notNull().default(180),
    status: text("status").notNull().default("completed"),
    totalCandidates: integer("total_candidates").notNull().default(0),
    activeCandidates: integer("active_candidates").notNull().default(0),
    canceledCandidates: integer("canceled_candidates").notNull().default(0),
    uncertainCandidates: integer("uncertain_candidates").notNull().default(0),
    summary: text("summary").notNull().default(""),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
);

export const lifeSubscriptionCandidates = financesSchema.table(
  "life_subscription_candidates",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    auditId: text("audit_id").notNull(),
    serviceSlug: text("service_slug").notNull(),
    serviceName: text("service_name").notNull(),
    provider: text("provider").notNull().default("unknown"),
    cadence: text("cadence").notNull().default("unknown"),
    state: text("state").notNull().default("uncertain"),
    confidence: real("confidence").notNull().default(0),
    annualCostEstimateUsd: real("annual_cost_estimate_usd"),
    managementUrl: text("management_url"),
    latestEvidenceAt: text("latest_evidence_at"),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.auditId, t.serviceSlug)],
);

export const lifeSubscriptionCancellations = financesSchema.table(
  "life_subscription_cancellations",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    auditId: text("audit_id"),
    candidateId: text("candidate_id"),
    serviceSlug: text("service_slug").notNull(),
    serviceName: text("service_name").notNull(),
    executor: text("executor").notNull().default("agent_browser"),
    status: text("status").notNull().default("draft"),
    confirmed: boolean("confirmed").notNull().default(false),
    currentStep: text("current_step"),
    browserSessionId: text("browser_session_id"),
    evidenceSummary: text("evidence_summary"),
    artifactCount: integer("artifact_count").notNull().default(0),
    managementUrl: text("management_url"),
    error: text("error"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
  },
);

export const lifePaymentSources = financesSchema.table("life_payment_sources", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  kind: text("kind").notNull().default("manual"),
  label: text("label").notNull().default(""),
  institution: text("institution"),
  accountMask: text("account_mask"),
  status: text("status").notNull().default("active"),
  lastSyncedAt: text("last_synced_at"),
  transactionCount: integer("transaction_count").notNull().default(0),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const lifePaymentTransactions = financesSchema.table(
  "life_payment_transactions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    sourceId: text("source_id").notNull(),
    externalId: text("external_id"),
    postedAt: text("posted_at").notNull(),
    // Legacy LifeOps-compatible storage; convert to minor units at API/UI edges.
    amountUsd: real("amount_usd").notNull().default(0),
    direction: text("direction").notNull().default("debit"),
    merchantRaw: text("merchant_raw").notNull().default(""),
    merchantNormalized: text("merchant_normalized").notNull().default(""),
    description: text("description"),
    category: text("category"),
    currency: text("currency").notNull().default("USD"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique().on(
      t.agentId,
      t.sourceId,
      t.postedAt,
      t.amountUsd,
      t.merchantNormalized,
    ),
  ],
);

/**
 * Aggregate schema object registered through the plugin `schema` field. The
 * SQL plugin's migration runner creates every table listed here under
 * `app_finances`.
 */
export const financesDbSchema = {
  lifeSubscriptionAudits,
  lifeSubscriptionCandidates,
  lifeSubscriptionCancellations,
  lifePaymentSources,
  lifePaymentTransactions,
} as const;

export type LifeSubscriptionAuditRow =
  typeof lifeSubscriptionAudits.$inferSelect;
export type LifeSubscriptionAuditInsert =
  typeof lifeSubscriptionAudits.$inferInsert;
export type LifeSubscriptionCandidateRow =
  typeof lifeSubscriptionCandidates.$inferSelect;
export type LifeSubscriptionCandidateInsert =
  typeof lifeSubscriptionCandidates.$inferInsert;
export type LifeSubscriptionCancellationRow =
  typeof lifeSubscriptionCancellations.$inferSelect;
export type LifeSubscriptionCancellationInsert =
  typeof lifeSubscriptionCancellations.$inferInsert;
export type LifePaymentSourceRow = typeof lifePaymentSources.$inferSelect;
export type LifePaymentSourceInsert = typeof lifePaymentSources.$inferInsert;
export type LifePaymentTransactionRow =
  typeof lifePaymentTransactions.$inferSelect;
export type LifePaymentTransactionInsert =
  typeof lifePaymentTransactions.$inferInsert;
