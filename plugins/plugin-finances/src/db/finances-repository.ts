/**
 * Raw-SQL repository for the finance back-end.
 *
 * Owns all reads/writes against the `app_finances` schema (payment sources,
 * payment transactions, subscription audits / candidates / cancellations).
 * Table NAMES are preserved verbatim from the original LifeOps tables
 * (`life_payment_*`, `life_subscription_*`) so the schema-copy migration in
 * {@link ../services/migration.ts} can move existing rows across schemas.
 *
 * Every statement qualifies its table with the `app_finances.` prefix via
 * {@link FINANCE_TABLES}. SQL execution + value encoding go through the
 * self-contained {@link ./sql.ts} helpers (the runtime DB handle), so this
 * repository has no dependency on plugin-personal-assistant.
 */

import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsPaymentDirection,
  LifeOpsPaymentSource,
  LifeOpsPaymentSourceKind,
  LifeOpsPaymentSourceStatus,
  LifeOpsPaymentTransaction,
} from "../payment-types.ts";
import type {
  LifeOpsSubscriptionAudit,
  LifeOpsSubscriptionCancellation,
  LifeOpsSubscriptionCandidate,
} from "../subscriptions-types.ts";
import {
  executeRawSql,
  parseJsonArray,
  parseJsonRecord,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
  toBoolean,
  toNumber,
  toText,
} from "./sql.ts";

const FINANCE_SCHEMA = "app_finances";
const FINANCE_TABLES = {
  paymentSources: `${FINANCE_SCHEMA}.life_payment_sources`,
  paymentTransactions: `${FINANCE_SCHEMA}.life_payment_transactions`,
  subscriptionAudits: `${FINANCE_SCHEMA}.life_subscription_audits`,
  subscriptionCandidates: `${FINANCE_SCHEMA}.life_subscription_candidates`,
  subscriptionCancellations: `${FINANCE_SCHEMA}.life_subscription_cancellations`,
} as const;

function isoNow(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Row parsers — DB row → domain object
// ---------------------------------------------------------------------------

function parseSubscriptionAudit(
  row: Record<string, unknown>,
): LifeOpsSubscriptionAudit {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    source: toText(row.source, "gmail") as LifeOpsSubscriptionAudit["source"],
    queryWindowDays: toNumber(row.query_window_days, 180),
    status: toText(
      row.status,
      "completed",
    ) as LifeOpsSubscriptionAudit["status"],
    totalCandidates: toNumber(row.total_candidates, 0),
    activeCandidates: toNumber(row.active_candidates, 0),
    canceledCandidates: toNumber(row.canceled_candidates, 0),
    uncertainCandidates: toNumber(row.uncertain_candidates, 0),
    summary: toText(row.summary),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseSubscriptionCandidate(
  row: Record<string, unknown>,
): LifeOpsSubscriptionCandidate {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    auditId: toText(row.audit_id),
    serviceSlug: toText(row.service_slug),
    serviceName: toText(row.service_name),
    provider: toText(row.provider),
    cadence: toText(
      row.cadence,
      "unknown",
    ) as LifeOpsSubscriptionCandidate["cadence"],
    state: toText(
      row.state,
      "uncertain",
    ) as LifeOpsSubscriptionCandidate["state"],
    confidence: toNumber(row.confidence, 0),
    annualCostEstimateUsd:
      row.annual_cost_estimate_usd === null ||
      row.annual_cost_estimate_usd === undefined
        ? null
        : toNumber(row.annual_cost_estimate_usd, 0),
    managementUrl: row.management_url ? toText(row.management_url) : null,
    latestEvidenceAt: row.latest_evidence_at
      ? toText(row.latest_evidence_at)
      : null,
    evidenceJson: parseJsonArray<Record<string, unknown>>(row.evidence_json),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseSubscriptionCancellation(
  row: Record<string, unknown>,
): LifeOpsSubscriptionCancellation {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    auditId: row.audit_id ? toText(row.audit_id) : null,
    candidateId: row.candidate_id ? toText(row.candidate_id) : null,
    serviceSlug: toText(row.service_slug),
    serviceName: toText(row.service_name),
    executor: toText(
      row.executor,
      "agent_browser",
    ) as LifeOpsSubscriptionCancellation["executor"],
    status: toText(
      row.status,
      "draft",
    ) as LifeOpsSubscriptionCancellation["status"],
    confirmed: toBoolean(row.confirmed),
    currentStep: row.current_step ? toText(row.current_step) : null,
    browserSessionId: row.browser_session_id
      ? toText(row.browser_session_id)
      : null,
    evidenceSummary: row.evidence_summary ? toText(row.evidence_summary) : null,
    artifactCount: toNumber(row.artifact_count, 0),
    managementUrl: row.management_url ? toText(row.management_url) : null,
    error: row.error ? toText(row.error) : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
    finishedAt: row.finished_at ? toText(row.finished_at) : null,
  };
}

function parsePaymentSource(
  row: Record<string, unknown>,
): LifeOpsPaymentSource {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    kind: toText(row.kind, "manual") as LifeOpsPaymentSourceKind,
    label: toText(row.label),
    institution: row.institution ? toText(row.institution) : null,
    accountMask: row.account_mask ? toText(row.account_mask) : null,
    status: toText(row.status, "active") as LifeOpsPaymentSourceStatus,
    lastSyncedAt: row.last_synced_at ? toText(row.last_synced_at) : null,
    transactionCount: toNumber(row.transaction_count, 0),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parsePaymentTransaction(
  row: Record<string, unknown>,
): LifeOpsPaymentTransaction {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    sourceId: toText(row.source_id),
    externalId: row.external_id ? toText(row.external_id) : null,
    postedAt: toText(row.posted_at),
    amountUsd: toNumber(row.amount_usd, 0),
    direction: toText(row.direction, "debit") as LifeOpsPaymentDirection,
    merchantRaw: toText(row.merchant_raw),
    merchantNormalized: toText(row.merchant_normalized),
    description: row.description ? toText(row.description) : null,
    category: row.category ? toText(row.category) : null,
    currency: toText(row.currency, "USD"),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Domain-object factories (id + timestamps)
// ---------------------------------------------------------------------------

export function createLifeOpsSubscriptionAudit(
  params: Omit<LifeOpsSubscriptionAudit, "id" | "createdAt" | "updatedAt">,
): LifeOpsSubscriptionAudit {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsSubscriptionCandidate(
  params: Omit<LifeOpsSubscriptionCandidate, "id" | "createdAt" | "updatedAt">,
): LifeOpsSubscriptionCandidate {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsSubscriptionCancellation(
  params: Omit<
    LifeOpsSubscriptionCancellation,
    "id" | "createdAt" | "updatedAt"
  >,
): LifeOpsSubscriptionCancellation {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class FinancesRepository {
  constructor(public readonly runtime: IAgentRuntime) {}

  async createSubscriptionAudit(
    audit: LifeOpsSubscriptionAudit,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO ${FINANCE_TABLES.subscriptionAudits} (
        id, agent_id, source, query_window_days, status, total_candidates,
        active_candidates, canceled_candidates, uncertain_candidates, summary,
        metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(audit.id)},
        ${sqlQuote(audit.agentId)},
        ${sqlQuote(audit.source)},
        ${sqlInteger(audit.queryWindowDays)},
        ${sqlQuote(audit.status)},
        ${sqlInteger(audit.totalCandidates)},
        ${sqlInteger(audit.activeCandidates)},
        ${sqlInteger(audit.canceledCandidates)},
        ${sqlInteger(audit.uncertainCandidates)},
        ${sqlQuote(audit.summary)},
        ${sqlJson(audit.metadata)},
        ${sqlQuote(audit.createdAt)},
        ${sqlQuote(audit.updatedAt)}
      )`,
    );
  }

  async updateSubscriptionAudit(
    audit: LifeOpsSubscriptionAudit,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `UPDATE ${FINANCE_TABLES.subscriptionAudits}
          SET source = ${sqlQuote(audit.source)},
              query_window_days = ${sqlInteger(audit.queryWindowDays)},
              status = ${sqlQuote(audit.status)},
              total_candidates = ${sqlInteger(audit.totalCandidates)},
              active_candidates = ${sqlInteger(audit.activeCandidates)},
              canceled_candidates = ${sqlInteger(audit.canceledCandidates)},
              uncertain_candidates = ${sqlInteger(audit.uncertainCandidates)},
              summary = ${sqlQuote(audit.summary)},
              metadata_json = ${sqlJson(audit.metadata)},
              updated_at = ${sqlQuote(audit.updatedAt)}
        WHERE id = ${sqlQuote(audit.id)}
          AND agent_id = ${sqlQuote(audit.agentId)}`,
    );
  }

  async getSubscriptionAudit(
    agentId: string,
    auditId: string,
  ): Promise<LifeOpsSubscriptionAudit | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM ${FINANCE_TABLES.subscriptionAudits}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(auditId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseSubscriptionAudit(row) : null;
  }

  async getLatestSubscriptionAudit(
    agentId: string,
  ): Promise<LifeOpsSubscriptionAudit | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM ${FINANCE_TABLES.subscriptionAudits}
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseSubscriptionAudit(row) : null;
  }

  async createSubscriptionCandidate(
    candidate: LifeOpsSubscriptionCandidate,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO ${FINANCE_TABLES.subscriptionCandidates} (
        id, agent_id, audit_id, service_slug, service_name, provider, cadence,
        state, confidence, annual_cost_estimate_usd, management_url,
        latest_evidence_at, evidence_json, metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(candidate.id)},
        ${sqlQuote(candidate.agentId)},
        ${sqlQuote(candidate.auditId)},
        ${sqlQuote(candidate.serviceSlug)},
        ${sqlQuote(candidate.serviceName)},
        ${sqlQuote(candidate.provider)},
        ${sqlQuote(candidate.cadence)},
        ${sqlQuote(candidate.state)},
        ${sqlNumber(candidate.confidence)},
        ${sqlNumber(candidate.annualCostEstimateUsd)},
        ${sqlText(candidate.managementUrl)},
        ${sqlText(candidate.latestEvidenceAt)},
        ${sqlJson(candidate.evidenceJson)},
        ${sqlJson(candidate.metadata)},
        ${sqlQuote(candidate.createdAt)},
        ${sqlQuote(candidate.updatedAt)}
      )
      ON CONFLICT(agent_id, audit_id, service_slug) DO UPDATE SET
        service_name = excluded.service_name,
        provider = excluded.provider,
        cadence = excluded.cadence,
        state = excluded.state,
        confidence = excluded.confidence,
        annual_cost_estimate_usd = excluded.annual_cost_estimate_usd,
        management_url = excluded.management_url,
        latest_evidence_at = excluded.latest_evidence_at,
        evidence_json = excluded.evidence_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async listSubscriptionCandidatesForAudit(
    agentId: string,
    auditId: string,
  ): Promise<LifeOpsSubscriptionCandidate[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM ${FINANCE_TABLES.subscriptionCandidates}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND audit_id = ${sqlQuote(auditId)}
        ORDER BY confidence DESC, service_name ASC`,
    );
    return rows.map(parseSubscriptionCandidate);
  }

  async getSubscriptionCandidate(
    agentId: string,
    candidateId: string,
  ): Promise<LifeOpsSubscriptionCandidate | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM ${FINANCE_TABLES.subscriptionCandidates}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(candidateId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseSubscriptionCandidate(row) : null;
  }

  async createSubscriptionCancellation(
    cancellation: LifeOpsSubscriptionCancellation,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO ${FINANCE_TABLES.subscriptionCancellations} (
        id, agent_id, audit_id, candidate_id, service_slug, service_name,
        executor, status, confirmed, current_step, browser_session_id,
        evidence_summary, artifact_count, management_url, error, metadata_json,
        created_at, updated_at, finished_at
      ) VALUES (
        ${sqlQuote(cancellation.id)},
        ${sqlQuote(cancellation.agentId)},
        ${sqlText(cancellation.auditId)},
        ${sqlText(cancellation.candidateId)},
        ${sqlQuote(cancellation.serviceSlug)},
        ${sqlQuote(cancellation.serviceName)},
        ${sqlQuote(cancellation.executor)},
        ${sqlQuote(cancellation.status)},
        ${sqlBoolean(cancellation.confirmed)},
        ${sqlText(cancellation.currentStep)},
        ${sqlText(cancellation.browserSessionId)},
        ${sqlText(cancellation.evidenceSummary)},
        ${sqlInteger(cancellation.artifactCount)},
        ${sqlText(cancellation.managementUrl)},
        ${sqlText(cancellation.error)},
        ${sqlJson(cancellation.metadata)},
        ${sqlQuote(cancellation.createdAt)},
        ${sqlQuote(cancellation.updatedAt)},
        ${sqlText(cancellation.finishedAt)}
      )`,
    );
  }

  async updateSubscriptionCancellation(
    cancellation: LifeOpsSubscriptionCancellation,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `UPDATE ${FINANCE_TABLES.subscriptionCancellations}
          SET audit_id = ${sqlText(cancellation.auditId)},
              candidate_id = ${sqlText(cancellation.candidateId)},
              service_slug = ${sqlQuote(cancellation.serviceSlug)},
              service_name = ${sqlQuote(cancellation.serviceName)},
              executor = ${sqlQuote(cancellation.executor)},
              status = ${sqlQuote(cancellation.status)},
              confirmed = ${sqlBoolean(cancellation.confirmed)},
              current_step = ${sqlText(cancellation.currentStep)},
              browser_session_id = ${sqlText(cancellation.browserSessionId)},
              evidence_summary = ${sqlText(cancellation.evidenceSummary)},
              artifact_count = ${sqlInteger(cancellation.artifactCount)},
              management_url = ${sqlText(cancellation.managementUrl)},
              error = ${sqlText(cancellation.error)},
              metadata_json = ${sqlJson(cancellation.metadata)},
              updated_at = ${sqlQuote(cancellation.updatedAt)},
              finished_at = ${sqlText(cancellation.finishedAt)}
        WHERE id = ${sqlQuote(cancellation.id)}
          AND agent_id = ${sqlQuote(cancellation.agentId)}`,
    );
  }

  async getSubscriptionCancellation(
    agentId: string,
    cancellationId: string,
  ): Promise<LifeOpsSubscriptionCancellation | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM ${FINANCE_TABLES.subscriptionCancellations}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(cancellationId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseSubscriptionCancellation(row) : null;
  }

  async getLatestSubscriptionCancellation(
    agentId: string,
    serviceSlug?: string,
  ): Promise<LifeOpsSubscriptionCancellation | null> {
    const serviceClause = serviceSlug
      ? `AND service_slug = ${sqlQuote(serviceSlug)}`
      : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM ${FINANCE_TABLES.subscriptionCancellations}
        WHERE agent_id = ${sqlQuote(agentId)}
          ${serviceClause}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseSubscriptionCancellation(row) : null;
  }

  async upsertPaymentSource(source: LifeOpsPaymentSource): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO ${FINANCE_TABLES.paymentSources} (
        id, agent_id, kind, label, institution, account_mask, status,
        last_synced_at, transaction_count, metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(source.id)},
        ${sqlQuote(source.agentId)},
        ${sqlQuote(source.kind)},
        ${sqlQuote(source.label)},
        ${sqlText(source.institution)},
        ${sqlText(source.accountMask)},
        ${sqlQuote(source.status)},
        ${sqlText(source.lastSyncedAt)},
        ${sqlInteger(source.transactionCount)},
        ${sqlJson(source.metadata)},
        ${sqlQuote(source.createdAt)},
        ${sqlQuote(source.updatedAt)}
      )
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        label = excluded.label,
        institution = excluded.institution,
        account_mask = excluded.account_mask,
        status = excluded.status,
        last_synced_at = excluded.last_synced_at,
        transaction_count = excluded.transaction_count,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async listPaymentSources(agentId: string): Promise<LifeOpsPaymentSource[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM ${FINANCE_TABLES.paymentSources}
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY created_at DESC`,
    );
    return rows.map(parsePaymentSource);
  }

  async getPaymentSource(
    agentId: string,
    sourceId: string,
  ): Promise<LifeOpsPaymentSource | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM ${FINANCE_TABLES.paymentSources}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(sourceId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parsePaymentSource(row) : null;
  }

  async deletePaymentSource(agentId: string, sourceId: string): Promise<void> {
    await executeRawSql(
      this.runtime,
      `DELETE FROM ${FINANCE_TABLES.paymentTransactions}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND source_id = ${sqlQuote(sourceId)}`,
    );
    await executeRawSql(
      this.runtime,
      `DELETE FROM ${FINANCE_TABLES.paymentSources}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(sourceId)}`,
    );
  }

  async deletePaymentTransactionById(
    agentId: string,
    transactionId: string,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `DELETE FROM ${FINANCE_TABLES.paymentTransactions}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(transactionId)}`,
    );
  }

  async insertPaymentTransaction(
    transaction: LifeOpsPaymentTransaction,
  ): Promise<boolean> {
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO ${FINANCE_TABLES.paymentTransactions} (
        id, agent_id, source_id, external_id, posted_at, amount_usd, direction,
        merchant_raw, merchant_normalized, description, category, currency,
        metadata_json, created_at
      ) VALUES (
        ${sqlQuote(transaction.id)},
        ${sqlQuote(transaction.agentId)},
        ${sqlQuote(transaction.sourceId)},
        ${sqlText(transaction.externalId)},
        ${sqlQuote(transaction.postedAt)},
        ${sqlNumber(transaction.amountUsd)},
        ${sqlQuote(transaction.direction)},
        ${sqlQuote(transaction.merchantRaw)},
        ${sqlQuote(transaction.merchantNormalized)},
        ${sqlText(transaction.description)},
        ${sqlText(transaction.category)},
        ${sqlQuote(transaction.currency)},
        ${sqlJson(transaction.metadata)},
        ${sqlQuote(transaction.createdAt)}
      )
      ON CONFLICT DO NOTHING
      RETURNING id`,
    );
    return rows.length > 0;
  }

  async listPaymentTransactions(
    agentId: string,
    args: {
      sourceId?: string | null;
      sinceAt?: string | null;
      untilAt?: string | null;
      limit?: number | null;
      merchantContains?: string | null;
      onlyDebits?: boolean | null;
    } = {},
  ): Promise<LifeOpsPaymentTransaction[]> {
    const limit = Math.max(1, Math.min(5000, Math.trunc(args.limit ?? 500)));
    const sourceClause = args.sourceId
      ? `AND source_id = ${sqlQuote(args.sourceId)}`
      : "";
    const sinceClause = args.sinceAt
      ? `AND posted_at >= ${sqlQuote(args.sinceAt)}`
      : "";
    const untilClause = args.untilAt
      ? `AND posted_at <= ${sqlQuote(args.untilAt)}`
      : "";
    const merchantClause = args.merchantContains
      ? `AND merchant_normalized LIKE ${sqlQuote(`%${args.merchantContains.trim().toLowerCase()}%`)}`
      : "";
    const directionClause = args.onlyDebits
      ? `AND direction = ${sqlQuote("debit")}`
      : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM ${FINANCE_TABLES.paymentTransactions}
        WHERE agent_id = ${sqlQuote(agentId)}
          ${sourceClause}
          ${sinceClause}
          ${untilClause}
          ${merchantClause}
          ${directionClause}
        ORDER BY posted_at DESC
        LIMIT ${limit}`,
    );
    return rows.map(parsePaymentTransaction);
  }

  async countPaymentTransactionsForSource(
    agentId: string,
    sourceId: string,
  ): Promise<number> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT COUNT(*) AS count
         FROM ${FINANCE_TABLES.paymentTransactions}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND source_id = ${sqlQuote(sourceId)}`,
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? toNumber(row.count ?? row.COUNT, 0) : 0;
  }
}
