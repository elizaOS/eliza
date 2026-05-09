// @ts-nocheck — Mixin pattern: each `withFoo()` returns a class that calls
// methods belonging to sibling mixins (e.g. `this.recordScreenTimeEvent`).
// Type checking each mixin in isolation surfaces 700+ phantom errors because
// the local TBase constraint can't see sibling mixin methods. Real type
// safety is enforced at the composed-service level (LifeOpsService class).
// Refactoring requires either declaration-merging every cross-mixin method
// or moving to a single composed interface — tracked as separate work.
import crypto from "node:crypto";
import path from "node:path";
import { resolveOAuthDir } from "@elizaos/agent";
import {
  type ParsedCsvTransaction,
  parseTransactionsCsv,
} from "./payment-csv-import.js";
import {
  detectRecurringCharges,
  normalizeMerchant,
} from "./payment-recurrence.js";
import type {
  AddPaymentSourceRequest,
  ImportTransactionsCsvRequest,
  ImportTransactionsCsvResult,
  LifeOpsPaymentSource,
  LifeOpsPaymentSourceKind,
  LifeOpsPaymentsDashboard,
  LifeOpsPaymentTransaction,
  LifeOpsRecurringCharge,
  LifeOpsSpendingCategoryBreakdown,
  LifeOpsSpendingSummary,
  LifeOpsUpcomingBill,
  ListTransactionsRequest,
  SpendingSummaryRequest,
} from "./payment-types.js";
import {
  type PaypalCallbackResponse,
  PaypalManagedClient,
  PaypalManagedClientError,
  type PaypalTransactionDto,
} from "./paypal-managed-client.js";
import {
  type PlaidExchangeResponse,
  PlaidManagedClient,
  PlaidManagedClientError,
  type PlaidSyncResponse,
  type PlaidTransactionDto,
} from "./plaid-managed-client.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import {
  fail,
  normalizeOptionalString,
  requireNonEmptyString,
} from "./service-normalize.js";
import { findLifeOpsSubscriptionPlaybook } from "./subscriptions-playbooks.js";
import {
  decryptTokenEnvelope,
  type EncryptedTokenEnvelope,
  encryptTokenPayload,
  isEncryptedTokenEnvelope,
  resolveTokenEncryptionKey,
} from "./token-encryption.js";

const DEFAULT_WINDOW_DAYS = 30;
const MS_PER_DAY = 86_400_000;
const VALID_SOURCE_KINDS: readonly LifeOpsPaymentSourceKind[] = [
  "csv",
  "plaid",
  "manual",
  "paypal",
  "email",
];

const EMAIL_SOURCE_LABEL = "Email bills";
const SENSITIVE_PAYMENT_SOURCE_METADATA_KEYS = new Set(["plaid", "paypal"]);

function paymentTokenStorageRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOAuthDir(env), "lifeops", "payments");
}

export function encryptPaymentMetadataToken(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): EncryptedTokenEnvelope {
  const normalized = requireNonEmptyString(token, "token");
  const key = resolveTokenEncryptionKey(paymentTokenStorageRoot(env), env);
  return encryptTokenPayload(normalized, key);
}

export function readPaymentMetadataToken(
  value: unknown,
  field: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isEncryptedTokenEnvelope(value)) {
    fail(409, `${field} token metadata is malformed. Re-link the account.`);
  }
  try {
    return decryptTokenEnvelope(
      value,
      resolveTokenEncryptionKey(paymentTokenStorageRoot(env), env),
    );
  } catch {
    fail(
      409,
      `${field} token metadata could not be decrypted. Restore ELIZA_TOKEN_ENCRYPTION_KEY or re-link the account.`,
    );
  }
}

export function sanitizePaymentSourceForClient(
  source: LifeOpsPaymentSource,
): LifeOpsPaymentSource {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source.metadata ?? {})) {
    if (!SENSITIVE_PAYMENT_SOURCE_METADATA_KEYS.has(key.toLowerCase())) {
      metadata[key] = value;
    }
  }
  return { ...source, metadata };
}

function normalizeSourceKind(value: unknown): LifeOpsPaymentSourceKind {
  if (typeof value !== "string") {
    fail(400, "paymentSource.kind must be a string.");
  }
  const normalized = value.trim().toLowerCase();
  if (!VALID_SOURCE_KINDS.includes(normalized as LifeOpsPaymentSourceKind)) {
    fail(
      400,
      `paymentSource.kind must be one of: ${VALID_SOURCE_KINDS.join(", ")}.`,
    );
  }
  return normalized as LifeOpsPaymentSourceKind;
}

function buildTransactionId(args: {
  agentId: string;
  sourceId: string;
  parsed: ParsedCsvTransaction;
}): string {
  // Deterministic id so re-importing the same CSV is idempotent under the
  // unique (agent, source, posted_at, amount, merchant) constraint.
  const key = [
    args.agentId,
    args.sourceId,
    args.parsed.postedAt,
    args.parsed.amountUsd.toFixed(2),
    args.parsed.merchantNormalized,
    args.parsed.rowIndex,
  ].join("|");
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 32);
}

function computeSpendingSummary(args: {
  transactions: readonly LifeOpsPaymentTransaction[];
  recurring: readonly LifeOpsRecurringCharge[];
  windowDays: number;
}): LifeOpsSpendingSummary {
  const sinceMs = Date.now() - args.windowDays * MS_PER_DAY;
  const scoped = args.transactions.filter((transaction) => {
    const ms = Date.parse(transaction.postedAt);
    return Number.isFinite(ms) && ms >= sinceMs;
  });

  let totalSpend = 0;
  let totalIncome = 0;
  const categoryTotals = new Map<string, { total: number; count: number }>();
  const merchantTotals = new Map<
    string,
    { display: string; total: number; count: number }
  >();

  for (const transaction of scoped) {
    if (transaction.direction === "debit") {
      totalSpend += transaction.amountUsd;
      const categoryKey = transaction.category ?? "Uncategorized";
      const existingCategory = categoryTotals.get(categoryKey);
      if (existingCategory) {
        existingCategory.total += transaction.amountUsd;
        existingCategory.count += 1;
      } else {
        categoryTotals.set(categoryKey, {
          total: transaction.amountUsd,
          count: 1,
        });
      }
      const merchantKey = transaction.merchantNormalized;
      const existingMerchant = merchantTotals.get(merchantKey);
      if (existingMerchant) {
        existingMerchant.total += transaction.amountUsd;
        existingMerchant.count += 1;
      } else {
        merchantTotals.set(merchantKey, {
          display: transaction.merchantRaw,
          total: transaction.amountUsd,
          count: 1,
        });
      }
    } else {
      totalIncome += transaction.amountUsd;
    }
  }

  const topCategories: LifeOpsSpendingCategoryBreakdown[] = Array.from(
    categoryTotals.entries(),
  )
    .map(([category, agg]) => ({
      category,
      totalUsd: Number(agg.total.toFixed(2)),
      transactionCount: agg.count,
    }))
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, 6);

  const topMerchants = Array.from(merchantTotals.entries())
    .map(([merchantNormalized, agg]) => ({
      merchantNormalized,
      merchantDisplay: agg.display,
      totalUsd: Number(agg.total.toFixed(2)),
      transactionCount: agg.count,
    }))
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, 10);

  const recurringSpendUsd = args.recurring.reduce((total, charge) => {
    if (charge.cadence === "irregular") {
      return total;
    }
    const monthly =
      charge.cadence === "weekly"
        ? charge.averageAmountUsd * 4.33
        : charge.cadence === "biweekly"
          ? charge.averageAmountUsd * 2.17
          : charge.cadence === "monthly"
            ? charge.averageAmountUsd
            : charge.cadence === "quarterly"
              ? charge.averageAmountUsd / 3
              : charge.averageAmountUsd / 12;
    return total + monthly;
  }, 0);

  const toDate = new Date().toISOString();
  const fromDate = new Date(sinceMs).toISOString();

  return {
    windowDays: args.windowDays,
    fromDate,
    toDate,
    totalSpendUsd: Number(totalSpend.toFixed(2)),
    totalIncomeUsd: Number(totalIncome.toFixed(2)),
    netUsd: Number((totalIncome - totalSpend).toFixed(2)),
    transactionCount: scoped.length,
    recurringSpendUsd: Number(recurringSpendUsd.toFixed(2)),
    topCategories,
    topMerchants,
  };
}

/** @internal */
export function withPayments<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsPaymentsMixin extends Base {
    async listPaymentSources(): Promise<LifeOpsPaymentSource[]> {
      const sources = await this.repository.listPaymentSources(this.agentId());
      return sources.map((source) => sanitizePaymentSourceForClient(source));
    }

    async addPaymentSource(
      request: AddPaymentSourceRequest,
    ): Promise<LifeOpsPaymentSource> {
      const kind = normalizeSourceKind(request.kind);
      const label = requireNonEmptyString(request.label, "label").slice(0, 120);
      const institution =
        normalizeOptionalString(request.institution)?.slice(0, 120) ?? null;
      const accountMask =
        normalizeOptionalString(request.accountMask)?.slice(0, 16) ?? null;
      const now = new Date().toISOString();
      const source: LifeOpsPaymentSource = {
        id: crypto.randomUUID(),
        agentId: this.agentId(),
        kind,
        label,
        institution,
        accountMask,
        status: kind === "plaid" ? "needs_attention" : "active",
        lastSyncedAt: null,
        transactionCount: 0,
        metadata:
          request.metadata && typeof request.metadata === "object"
            ? { ...request.metadata }
            : {},
        createdAt: now,
        updatedAt: now,
      };
      await this.repository.upsertPaymentSource(source);
      return source;
    }

    async deletePaymentSource(sourceId: string): Promise<{ ok: true }> {
      const trimmed = requireNonEmptyString(sourceId, "sourceId");
      await this.repository.deletePaymentSource(this.agentId(), trimmed);
      return { ok: true };
    }

    async importTransactionsCsv(
      request: ImportTransactionsCsvRequest,
    ): Promise<ImportTransactionsCsvResult> {
      const sourceId = requireNonEmptyString(request.sourceId, "sourceId");
      const csvText = requireNonEmptyString(request.csvText, "csvText");
      const source = await this.repository.getPaymentSource(
        this.agentId(),
        sourceId,
      );
      if (!source) {
        fail(404, `Payment source ${sourceId} not found.`);
      }
      const parsed = parseTransactionsCsv(csvText, {
        dateColumn: request.dateColumn,
        amountColumn: request.amountColumn,
        merchantColumn: request.merchantColumn,
        descriptionColumn: request.descriptionColumn,
        categoryColumn: request.categoryColumn,
      });
      let inserted = 0;
      let skipped = 0;
      for (const txn of parsed.transactions) {
        const record: LifeOpsPaymentTransaction = {
          id: buildTransactionId({
            agentId: this.agentId(),
            sourceId,
            parsed: txn,
          }),
          agentId: this.agentId(),
          sourceId,
          externalId: txn.externalId,
          postedAt: txn.postedAt,
          amountUsd: Number(txn.amountUsd.toFixed(2)),
          direction: txn.direction,
          merchantRaw: txn.merchantRaw,
          merchantNormalized:
            txn.merchantNormalized || normalizeMerchant(txn.merchantRaw),
          description: txn.description,
          category: txn.category,
          currency: txn.currency,
          metadata: { sourceRowIndex: txn.rowIndex },
          createdAt: new Date().toISOString(),
        };
        const didInsert =
          await this.repository.insertPaymentTransaction(record);
        if (didInsert) {
          inserted += 1;
        } else {
          skipped += 1;
        }
      }
      const newCount = await this.repository.countPaymentTransactionsForSource(
        this.agentId(),
        sourceId,
      );
      await this.repository.upsertPaymentSource({
        ...source,
        status: "active",
        lastSyncedAt: new Date().toISOString(),
        transactionCount: newCount,
        updatedAt: new Date().toISOString(),
      });
      return {
        sourceId,
        rowsRead: parsed.rowsRead,
        inserted,
        skipped,
        errors: parsed.errors,
      };
    }

    async listTransactions(
      request: ListTransactionsRequest = {},
    ): Promise<LifeOpsPaymentTransaction[]> {
      return this.repository.listPaymentTransactions(this.agentId(), {
        sourceId: normalizeOptionalString(request.sourceId) ?? null,
        sinceAt: normalizeOptionalString(request.sinceAt) ?? null,
        untilAt: normalizeOptionalString(request.untilAt) ?? null,
        limit:
          typeof request.limit === "number" && Number.isFinite(request.limit)
            ? Math.trunc(request.limit)
            : null,
        merchantContains:
          normalizeOptionalString(request.merchantContains) ?? null,
        onlyDebits: request.onlyDebits ?? null,
      });
    }

    async getRecurringCharges(
      args: { sourceId?: string | null; sinceDays?: number | null } = {},
    ): Promise<LifeOpsRecurringCharge[]> {
      const sinceDays = Math.max(
        30,
        Math.min(
          720,
          typeof args.sinceDays === "number" && Number.isFinite(args.sinceDays)
            ? Math.trunc(args.sinceDays)
            : 365,
        ),
      );
      const transactions = await this.listTransactions({
        sourceId: args.sourceId ?? null,
        sinceAt: new Date(Date.now() - sinceDays * MS_PER_DAY).toISOString(),
        limit: 5000,
        onlyDebits: true,
      });
      return detectRecurringCharges(transactions);
    }

    async getSpendingSummary(
      request: SpendingSummaryRequest = {},
    ): Promise<LifeOpsSpendingSummary> {
      const windowDays = Math.max(
        1,
        Math.min(
          365,
          typeof request.windowDays === "number" &&
            Number.isFinite(request.windowDays)
            ? Math.trunc(request.windowDays)
            : DEFAULT_WINDOW_DAYS,
        ),
      );
      const transactions = await this.listTransactions({
        sourceId: request.sourceId ?? null,
        sinceAt: new Date(Date.now() - windowDays * MS_PER_DAY).toISOString(),
        limit: 5000,
      });
      const recurring = await this.getRecurringCharges({
        sourceId: request.sourceId ?? null,
        sinceDays: Math.max(windowDays, 180),
      });
      return computeSpendingSummary({
        transactions,
        recurring,
        windowDays,
      });
    }

    async getPaymentsDashboard(
      args: { windowDays?: number | null } = {},
    ): Promise<LifeOpsPaymentsDashboard> {
      const windowDays = Math.max(
        7,
        Math.min(
          365,
          typeof args.windowDays === "number" &&
            Number.isFinite(args.windowDays)
            ? Math.trunc(args.windowDays)
            : DEFAULT_WINDOW_DAYS,
        ),
      );
      const [sources, recurring, spending, upcomingBills] = await Promise.all([
        this.listPaymentSources(),
        this.getRecurringCharges({}),
        this.getSpendingSummary({ windowDays }),
        this.getUpcomingBills(),
      ]);
      const latestAudit = await this.repository.getLatestSubscriptionAudit(
        this.agentId(),
      );
      // Use the free `findLifeOpsSubscriptionPlaybook` function rather than
      // `this.findSubscriptionPlaybookForMerchant`, because the Payments mixin
      // is composed BELOW Subscriptions in service.ts and cannot see methods
      // declared by mixins layered above it.
      const recurringPlaybookHits = recurring
        .map((charge) => {
          const direct =
            findLifeOpsSubscriptionPlaybook(charge.merchantDisplay) ??
            findLifeOpsSubscriptionPlaybook(charge.merchantNormalized);
          if (!direct) {
            return null;
          }
          return {
            merchantNormalized: charge.merchantNormalized,
            playbookKey: direct.key,
            serviceName: direct.serviceName,
            managementUrl: direct.managementUrl,
            executorPreference: direct.executorPreference,
          };
        })
        .filter((hit): hit is NonNullable<typeof hit> => hit !== null);
      return {
        sources,
        recurring,
        recurringPlaybookHits,
        spending,
        upcomingBills,
        gmailSubscriptionAuditId: latestAudit?.id ?? null,
        generatedAt: new Date().toISOString(),
      };
    }

    /**
     * Look up the singleton "Email bills" payment source for this agent,
     * creating it on first use. Bills detected from email are persisted
     * against this source so the existing transactions table can carry them
     * without a parallel schema. Cannot be `private` — TS4094 fires when
     * the mixin's anonymous class is re-exported.
     */
    async getOrCreateEmailPaymentSource(): Promise<LifeOpsPaymentSource> {
      const sources = await this.listPaymentSources();
      const existing = sources.find((source) => source.kind === "email");
      if (existing) return existing;
      const now = new Date().toISOString();
      const source: LifeOpsPaymentSource = {
        id: crypto.randomUUID(),
        agentId: this.agentId(),
        kind: "email",
        label: EMAIL_SOURCE_LABEL,
        institution: null,
        accountMask: null,
        status: "active",
        lastSyncedAt: now,
        transactionCount: 0,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      };
      await this.repository.upsertPaymentSource(source);
      return source;
    }

    /**
     * Idempotent insert of a bill extracted from an email. The transaction
     * id is derived from `(agent, sourceId, sourceMessageId)` so re-ingesting
     * the same Gmail message never creates a duplicate row.
     */
    async upsertBillFromEmail(args: {
      sourceMessageId: string;
      merchant: string;
      amountUsd: number;
      currency: string;
      dueDate: string | null;
      postedAt?: string | null;
      confidence: number;
    }): Promise<{ inserted: boolean; transactionId: string }> {
      const source = await this.getOrCreateEmailPaymentSource();
      const merchantRaw = requireNonEmptyString(
        args.merchant,
        "merchant",
      ).slice(0, 200);
      const externalId = `email:${args.sourceMessageId}`;
      const transactionId = crypto
        .createHash("sha1")
        .update(`${this.agentId()}|${source.id}|${args.sourceMessageId}`)
        .digest("hex")
        .slice(0, 32);
      const postedAt =
        normalizeOptionalString(args.postedAt) ?? new Date().toISOString();
      const record: LifeOpsPaymentTransaction = {
        id: transactionId,
        agentId: this.agentId(),
        sourceId: source.id,
        externalId,
        postedAt,
        amountUsd: Number(Math.abs(args.amountUsd).toFixed(2)),
        direction: "debit",
        merchantRaw,
        merchantNormalized: merchantRaw.toLowerCase().slice(0, 200),
        description: null,
        category: "Bills",
        currency: args.currency || "USD",
        metadata: {
          kind: "bill",
          sourceMessageId: args.sourceMessageId,
          dueDate: args.dueDate,
          confidence: Number(args.confidence.toFixed(2)),
        },
        createdAt: new Date().toISOString(),
      };
      const inserted = await this.repository.insertPaymentTransaction(record);
      if (inserted) {
        const newCount =
          await this.repository.countPaymentTransactionsForSource(
            this.agentId(),
            source.id,
          );
        await this.repository.upsertPaymentSource({
          ...source,
          lastSyncedAt: new Date().toISOString(),
          transactionCount: newCount,
          updatedAt: new Date().toISOString(),
        });
      }
      return { inserted, transactionId };
    }

    /**
     * Mark a previously-extracted bill as paid. Idempotent — repeated calls
     * just re-stamp the metadata. The row itself is not deleted so the
     * transaction history stays intact.
     */
    async markBillPaid(args: {
      billId: string;
      paidAt?: string | null;
    }): Promise<{ ok: true }> {
      const billId = requireNonEmptyString(args.billId, "billId");
      const transactions = await this.repository.listPaymentTransactions(
        this.agentId(),
        { limit: 5000 },
      );
      const target = transactions.find((tx) => tx.id === billId);
      if (!target) {
        fail(404, `Bill ${billId} not found.`);
      }
      const paidAt =
        normalizeOptionalString(args.paidAt) ?? new Date().toISOString();
      const nextMetadata = {
        ...target.metadata,
        kind: "bill_paid",
        paidAt,
      };
      // The schema has no UPDATE helper for payment transactions yet — the
      // simplest correct approach is to delete + re-insert with a different
      // primary key (paid bills should NOT continue to surface as upcoming).
      // For now, we mark via a metadata-side write only, which still removes
      // the row from upcoming bills since `getUpcomingBills` filters on
      // `kind === "bill"`.
      await this.repository.deletePaymentTransactionById(
        this.agentId(),
        billId,
      );
      await this.repository.insertPaymentTransaction({
        ...target,
        // Keep the same id so callers can reference the bill in audit trails.
        metadata: nextMetadata,
      });
      return { ok: true };
    }

    /**
     * Push a bill's due date out by N days. Used for "Snooze 1w" UI.
     */
    async snoozeBill(args: {
      billId: string;
      days: number;
    }): Promise<{ ok: true; dueDate: string }> {
      const billId = requireNonEmptyString(args.billId, "billId");
      const days =
        Number.isFinite(args.days) && args.days > 0
          ? Math.min(60, Math.trunc(args.days))
          : 7;
      const transactions = await this.repository.listPaymentTransactions(
        this.agentId(),
        { limit: 5000 },
      );
      const target = transactions.find((tx) => tx.id === billId);
      if (!target) {
        fail(404, `Bill ${billId} not found.`);
      }
      const currentDue =
        typeof target.metadata?.dueDate === "string"
          ? target.metadata.dueDate
          : null;
      const baseDate = currentDue
        ? new Date(`${currentDue}T00:00:00.000Z`)
        : new Date();
      if (Number.isNaN(baseDate.getTime())) {
        fail(409, "Bill has an unparseable due date.");
      }
      const nextDue = new Date(baseDate.getTime() + days * 86_400_000)
        .toISOString()
        .slice(0, 10);
      await this.repository.deletePaymentTransactionById(
        this.agentId(),
        billId,
      );
      await this.repository.insertPaymentTransaction({
        ...target,
        metadata: {
          ...target.metadata,
          dueDate: nextDue,
        },
      });
      return { ok: true, dueDate: nextDue };
    }

    /**
     * Read bills extracted from email. This includes overdue and no-date bills
     * so extraction misses do not disappear from the user's review queue.
     */
    async getUpcomingBills(
      args: { now?: Date } = {},
    ): Promise<LifeOpsUpcomingBill[]> {
      const sources = await this.listPaymentSources();
      const emailSource = sources.find((source) => source.kind === "email");
      if (!emailSource) return [];
      const transactions = await this.repository.listPaymentTransactions(
        this.agentId(),
        {
          sourceId: emailSource.id,
          limit: 200,
        },
      );
      const now = args.now ?? new Date();
      const todayIso = now.toISOString().slice(0, 10);
      const bills: LifeOpsUpcomingBill[] = [];
      for (const transaction of transactions) {
        const metadata = transaction.metadata ?? {};
        if (metadata.kind !== "bill") continue;
        const dueDate =
          typeof metadata.dueDate === "string" ? metadata.dueDate : null;
        const status =
          dueDate === null
            ? "needs_due_date"
            : dueDate < todayIso
              ? "overdue"
              : "upcoming";
        const sourceMessageId =
          typeof metadata.sourceMessageId === "string"
            ? metadata.sourceMessageId
            : null;
        const confidence =
          typeof metadata.confidence === "number" &&
          Number.isFinite(metadata.confidence)
            ? metadata.confidence
            : 0.5;
        bills.push({
          id: transaction.id,
          merchant: transaction.merchantRaw,
          amountUsd: transaction.amountUsd,
          currency: transaction.currency,
          dueDate,
          status,
          postedAt: transaction.postedAt,
          sourceMessageId,
          confidence,
        });
      }
      const statusRank: Record<LifeOpsUpcomingBill["status"], number> = {
        overdue: 0,
        needs_due_date: 1,
        upcoming: 2,
      };
      bills.sort((a, b) => {
        const rankDelta = statusRank[a.status] - statusRank[b.status];
        if (rankDelta !== 0) return rankDelta;
        if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
        if (a.dueDate) return 1;
        if (b.dueDate) return -1;
        return b.postedAt.localeCompare(a.postedAt);
      });
      return bills;
    }

    summarizePaymentsDashboard(dashboard: LifeOpsPaymentsDashboard): string {
      const lines = [
        `Spent $${dashboard.spending.totalSpendUsd.toFixed(2)} in the last ${dashboard.spending.windowDays} days across ${dashboard.spending.transactionCount} transactions.`,
      ];
      if (dashboard.recurring.length > 0) {
        const annualized = dashboard.recurring.reduce(
          (total, charge) => total + charge.annualizedCostUsd,
          0,
        );
        lines.push(
          `Detected ${dashboard.recurring.length} recurring charge${dashboard.recurring.length === 1 ? "" : "s"} worth ~$${annualized.toFixed(2)}/yr.`,
        );
        const topThree = dashboard.recurring.slice(0, 3);
        for (const charge of topThree) {
          lines.push(
            `- ${charge.merchantDisplay} (${charge.cadence}, $${charge.averageAmountUsd.toFixed(2)})`,
          );
        }
      } else {
        lines.push(
          "No recurring charges detected yet. Import transactions to start tracking.",
        );
      }
      if (dashboard.sources.length === 0) {
        lines.push(
          "No payment sources connected. Add one (CSV import) to see your spending.",
        );
      }
      return lines.join("\n");
    }

    // -----------------------------------------------------------------------
    // Plaid bridge — uses Eliza Cloud as the secret holder for the Plaid
    // access_token. Cloud routes live at /api/v1/eliza/plaid/*.
    // -----------------------------------------------------------------------

    // Cannot be `private` — TS4094 fires when the mixin's anonymous class
    // is re-exported through the composed LifeOpsService.
    getPlaidManagedClient(): PlaidManagedClient {
      if (!this.plaidManagedClientCache) {
        this.plaidManagedClientCache = new PlaidManagedClient();
      }
      return this.plaidManagedClientCache;
    }

    /** Returns a Plaid Link token for the frontend to drive the Plaid Link UI. */
    async createPlaidLinkToken(): Promise<{
      linkToken: string;
      expiration: string;
      environment: string;
    }> {
      try {
        return await this.getPlaidManagedClient().createLinkToken();
      } catch (error) {
        if (error instanceof PlaidManagedClientError) {
          fail(error.status, error.message);
        }
        throw error;
      }
    }

    /**
     * Completes a Plaid Link flow by exchanging the public_token for an
     * access_token and creating (or updating) a payment_source row whose
     * metadata holds the access_token + cursor for sync.
     */
    async completePlaidLink(args: {
      publicToken: string;
      label?: string | null;
    }): Promise<LifeOpsPaymentSource> {
      const publicToken = requireNonEmptyString(
        args.publicToken,
        "publicToken",
      );
      let result: PlaidExchangeResponse;
      try {
        result = await this.getPlaidManagedClient().exchangePublicToken({
          publicToken,
        });
      } catch (error) {
        if (error instanceof PlaidManagedClientError) {
          fail(error.status, error.message);
        }
        throw error;
      }
      const label =
        normalizeOptionalString(args.label) ??
        `${result.institution.institutionName}${
          result.institution.primaryAccountMask
            ? ` ··${result.institution.primaryAccountMask}`
            : ""
        }`;
      const now = new Date().toISOString();
      const source: LifeOpsPaymentSource = {
        id: crypto.randomUUID(),
        agentId: this.agentId(),
        kind: "plaid",
        label: label.slice(0, 120),
        institution: result.institution.institutionName.slice(0, 120),
        accountMask:
          result.institution.primaryAccountMask?.slice(0, 16) ?? null,
        status: "active",
        lastSyncedAt: null,
        transactionCount: 0,
        metadata: {
          plaid: {
            accessToken: encryptPaymentMetadataToken(result.accessToken),
            itemId: result.itemId,
            institutionId: result.institution.institutionId,
            cursor: "",
            accounts: result.institution.accounts,
          },
        },
        createdAt: now,
        updatedAt: now,
      };
      await this.repository.upsertPaymentSource(source);
      return source;
    }

    /**
     * Pulls the latest transaction delta for a Plaid-backed source and
     * inserts the new rows into life_payment_transactions.
     */
    async syncPlaidTransactions(args: {
      sourceId: string;
    }): Promise<{ inserted: number; skipped: number; nextCursor: string }> {
      const sourceId = requireNonEmptyString(args.sourceId, "sourceId");
      const source = await this.repository.getPaymentSource(
        this.agentId(),
        sourceId,
      );
      if (!source) {
        fail(404, `Payment source ${sourceId} not found.`);
      }
      if (source.kind !== "plaid") {
        fail(409, `Source ${sourceId} is not a Plaid source.`);
      }
      const plaidMetadata =
        (source.metadata?.plaid as
          | { accessToken?: unknown; cursor?: string }
          | undefined) ?? null;
      const accessToken = readPaymentMetadataToken(
        plaidMetadata?.accessToken,
        "Plaid access",
      );
      if (!accessToken) {
        fail(
          409,
          "Plaid source is missing an access token. Re-link the account.",
        );
      }
      const cursor = plaidMetadata?.cursor ?? "";

      let cumulativeInserted = 0;
      let cumulativeSkipped = 0;
      let pageCursor = cursor;
      let hasMore = true;
      let pageGuard = 0;
      while (hasMore && pageGuard < 20) {
        let delta: PlaidSyncResponse;
        try {
          delta = await this.getPlaidManagedClient().syncTransactions({
            accessToken,
            cursor: pageCursor,
          });
        } catch (error) {
          if (error instanceof PlaidManagedClientError) {
            fail(error.status, error.message);
          }
          throw error;
        }
        for (const transaction of delta.added) {
          const inserted = await this.upsertPlaidTransaction({
            sourceId,
            transaction,
          });
          if (inserted) {
            cumulativeInserted += 1;
          } else {
            cumulativeSkipped += 1;
          }
        }
        for (const transaction of delta.modified) {
          await this.upsertPlaidTransaction({
            sourceId,
            transaction,
          });
        }
        pageCursor = delta.nextCursor;
        hasMore = delta.hasMore;
        pageGuard += 1;
      }
      const newCount = await this.repository.countPaymentTransactionsForSource(
        this.agentId(),
        sourceId,
      );
      await this.repository.upsertPaymentSource({
        ...source,
        status: "active",
        lastSyncedAt: new Date().toISOString(),
        transactionCount: newCount,
        metadata: {
          ...source.metadata,
          plaid: {
            ...plaidMetadata,
            accessToken: encryptPaymentMetadataToken(accessToken),
            cursor: pageCursor,
          },
        },
        updatedAt: new Date().toISOString(),
      });
      return {
        inserted: cumulativeInserted,
        skipped: cumulativeSkipped,
        nextCursor: pageCursor,
      };
    }

    // -----------------------------------------------------------------------
    // PayPal bridge — uses Eliza Cloud as the OAuth + Reporting API proxy.
    // Cloud routes live at /api/v1/eliza/paypal/*.
    //
    // Personal-tier PayPal accounts CANNOT use the Reporting API. The cloud
    // surfaces this as a 403 with `fallback: "csv_export"`; we propagate
    // that to the caller via PaypalManagedClientError.fallback so the UI
    // can route the user to CSV import.
    // -----------------------------------------------------------------------

    // Cannot be `private` — TS4094 fires when the mixin's anonymous class
    // is re-exported through the composed LifeOpsService.
    getPaypalManagedClient(): PaypalManagedClient {
      if (!this.paypalManagedClientCache) {
        this.paypalManagedClientCache = new PaypalManagedClient();
      }
      return this.paypalManagedClientCache;
    }

    /** Returns a PayPal Login URL the frontend should open in a popup. */
    async createPaypalAuthorizeUrl(args: { state: string }): Promise<{
      url: string;
      scope: string;
      environment: "live" | "sandbox";
    }> {
      const state = requireNonEmptyString(args.state, "state");
      try {
        return await this.getPaypalManagedClient().buildAuthorizeUrl({ state });
      } catch (error) {
        if (error instanceof PaypalManagedClientError) {
          fail(error.status, error.message);
        }
        throw error;
      }
    }

    /**
     * Completes the PayPal OAuth flow by exchanging the authorization code
     * for tokens, then creating a payment_source row keyed to the PayPal
     * payer. The access_token + refresh_token are stored in source.metadata
     * so the runtime can refresh on demand without re-prompting the user.
     */
    async completePaypalLink(args: {
      code: string;
      label?: string | null;
    }): Promise<{
      source: LifeOpsPaymentSource;
      capability: { hasReporting: boolean; hasIdentity: boolean };
    }> {
      const code = requireNonEmptyString(args.code, "code");
      let exchange: PaypalCallbackResponse;
      try {
        exchange = await this.getPaypalManagedClient().exchangeCode({ code });
      } catch (error) {
        if (error instanceof PaypalManagedClientError) {
          fail(error.status, error.message);
        }
        throw error;
      }
      const display =
        exchange.identity?.name ??
        exchange.identity?.emails[0] ??
        exchange.identity?.payerId ??
        "PayPal";
      const label =
        normalizeOptionalString(args.label) ?? `PayPal · ${display}`;
      const tokenExpiresAt = new Date(
        Date.now() + Math.max(0, exchange.expiresIn - 60) * 1_000,
      ).toISOString();
      const now = new Date().toISOString();
      const source: LifeOpsPaymentSource = {
        id: crypto.randomUUID(),
        agentId: this.agentId(),
        kind: "paypal",
        label: label.slice(0, 120),
        institution: "PayPal",
        accountMask: null,
        // Personal-tier accounts can't sync, so we mark them as
        // needs_attention to nudge the user toward CSV import.
        status: exchange.capability.hasReporting ? "active" : "needs_attention",
        lastSyncedAt: null,
        transactionCount: 0,
        metadata: {
          paypal: {
            accessToken: encryptPaymentMetadataToken(exchange.accessToken),
            refreshToken: exchange.refreshToken
              ? encryptPaymentMetadataToken(exchange.refreshToken)
              : null,
            tokenExpiresAt,
            scope: exchange.scope,
            capability: exchange.capability,
            payerId: exchange.identity?.payerId ?? null,
            payerEmails: exchange.identity?.emails ?? [],
          },
        },
        createdAt: now,
        updatedAt: now,
      };
      await this.repository.upsertPaymentSource(source);
      return { source, capability: exchange.capability };
    }

    /**
     * Pulls PayPal transactions for a date window via the Reporting API.
     * Returns the imported count and an explicit `fallback: "csv_export"`
     * flag when the account is personal-tier.
     */
    async syncPaypalTransactions(args: {
      sourceId: string;
      windowDays?: number | null;
    }): Promise<{
      inserted: number;
      skipped: number;
      fallback: "csv_export" | null;
    }> {
      const sourceId = requireNonEmptyString(args.sourceId, "sourceId");
      const source = await this.repository.getPaymentSource(
        this.agentId(),
        sourceId,
      );
      if (!source) {
        fail(404, `Payment source ${sourceId} not found.`);
      }
      if (source.kind !== "paypal") {
        fail(409, `Source ${sourceId} is not a PayPal source.`);
      }
      let paypalMetadata =
        (source.metadata?.paypal as
          | {
              accessToken?: unknown;
              refreshToken?: unknown;
              tokenExpiresAt?: string;
              capability?: { hasReporting: boolean; hasIdentity: boolean };
            }
          | undefined) ?? null;
      let accessToken = readPaymentMetadataToken(
        paypalMetadata?.accessToken,
        "PayPal access",
      );
      let refreshToken = readPaymentMetadataToken(
        paypalMetadata?.refreshToken,
        "PayPal refresh",
      );
      if (!accessToken) {
        fail(409, "PayPal source is missing an access token. Re-link.");
      }
      // Refresh if we're within 60s of expiry — saves a round-trip 401.
      const expiryMs = paypalMetadata?.tokenExpiresAt
        ? Date.parse(paypalMetadata.tokenExpiresAt)
        : 0;
      if (Number.isFinite(expiryMs) && expiryMs <= Date.now() + 60_000) {
        if (refreshToken) {
          try {
            const refreshed =
              await this.getPaypalManagedClient().refreshAccessToken({
                refreshToken,
              });
            accessToken = refreshed.accessToken;
            refreshToken = refreshed.refreshToken ?? refreshToken;
            const tokenExpiresAt = new Date(
              Date.now() + Math.max(0, refreshed.expiresIn - 60) * 1_000,
            ).toISOString();
            paypalMetadata = {
              ...paypalMetadata,
              accessToken: encryptPaymentMetadataToken(accessToken),
              refreshToken: refreshToken
                ? encryptPaymentMetadataToken(refreshToken)
                : null,
              tokenExpiresAt,
              scope: refreshed.scope,
            };
            await this.repository.upsertPaymentSource({
              ...source,
              metadata: {
                ...source.metadata,
                paypal: paypalMetadata,
              },
              updatedAt: new Date().toISOString(),
            });
          } catch (error) {
            // Refresh failed — fall through with the stale token; the
            // search call below will likely 401 and surface a clear error.
            this.logLifeOpsWarn(
              "paypal_refresh",
              `PayPal refresh failed for ${sourceId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }

      const windowDays = Math.max(
        7,
        Math.min(
          365,
          typeof args.windowDays === "number" &&
            Number.isFinite(args.windowDays)
            ? Math.trunc(args.windowDays)
            : 90,
        ),
      );
      const now = new Date();
      const startDate = new Date(
        now.getTime() - windowDays * MS_PER_DAY,
      ).toISOString();
      const endDate = now.toISOString();

      let inserted = 0;
      let skipped = 0;
      let page = 1;
      let totalPages = 1;
      try {
        do {
          const result = await this.getPaypalManagedClient().searchTransactions(
            {
              accessToken,
              startDate,
              endDate,
              page,
            },
          );
          totalPages = result.totalPages;
          for (const transaction of result.transactions) {
            const wasInserted = await this.upsertPaypalTransaction({
              sourceId,
              transaction,
            });
            if (wasInserted) {
              inserted += 1;
            } else {
              skipped += 1;
            }
          }
          page += 1;
        } while (page <= totalPages && page <= 50);
      } catch (error) {
        if (
          error instanceof PaypalManagedClientError &&
          error.fallback === "csv_export"
        ) {
          // Personal-tier — mark the source so the UI nudges to CSV import.
          await this.repository.upsertPaymentSource({
            ...source,
            status: "needs_attention",
            metadata: {
              ...source.metadata,
              paypal: {
                ...paypalMetadata,
                accessToken: encryptPaymentMetadataToken(accessToken),
                refreshToken: refreshToken
                  ? encryptPaymentMetadataToken(refreshToken)
                  : null,
                capability: { hasReporting: false, hasIdentity: true },
                lastFallbackError: error.message,
              },
            },
            updatedAt: new Date().toISOString(),
          });
          return { inserted: 0, skipped: 0, fallback: "csv_export" };
        }
        if (error instanceof PaypalManagedClientError) {
          fail(error.status, error.message);
        }
        throw error;
      }

      const newCount = await this.repository.countPaymentTransactionsForSource(
        this.agentId(),
        sourceId,
      );
      await this.repository.upsertPaymentSource({
        ...source,
        status: "active",
        lastSyncedAt: new Date().toISOString(),
        transactionCount: newCount,
        metadata: {
          ...source.metadata,
          paypal: {
            ...paypalMetadata,
            accessToken: encryptPaymentMetadataToken(accessToken),
            refreshToken: refreshToken
              ? encryptPaymentMetadataToken(refreshToken)
              : null,
          },
        },
        updatedAt: new Date().toISOString(),
      });
      return { inserted, skipped, fallback: null };
    }

    // Cannot be `private` — TS4094 fires when the mixin's anonymous class
    // is re-exported through the composed LifeOpsService.
    async upsertPaypalTransaction(args: {
      sourceId: string;
      transaction: PaypalTransactionDto;
    }): Promise<boolean> {
      const txn = args.transaction;
      const amountValue = Number(txn.transaction_info.transaction_amount.value);
      if (!Number.isFinite(amountValue)) {
        return false;
      }
      // PayPal convention: positive = money IN (credit), negative = money OUT.
      // Our schema uses the absolute value + a `direction` enum.
      const direction = amountValue < 0 ? "debit" : "credit";
      const merchantRaw = (
        txn.payer_info?.payer_name?.alternate_full_name ??
        txn.payer_info?.email_address ??
        txn.shipping_info?.name ??
        txn.transaction_info.transaction_subject ??
        "PayPal payment"
      ).trim();
      const merchantNormalized = normalizeMerchant(merchantRaw);
      const description =
        txn.transaction_info.transaction_subject ??
        txn.transaction_info.transaction_note ??
        txn.cart_info?.item_details?.[0]?.item_name ??
        null;
      const record: LifeOpsPaymentTransaction = {
        id: crypto.randomUUID(),
        agentId: this.agentId(),
        sourceId: args.sourceId,
        externalId: txn.transaction_info.transaction_id,
        postedAt: new Date(
          txn.transaction_info.transaction_initiation_date,
        ).toISOString(),
        amountUsd: Number(Math.abs(amountValue).toFixed(2)),
        direction,
        merchantRaw,
        merchantNormalized,
        description,
        category: null,
        currency: txn.transaction_info.transaction_amount.currency_code,
        metadata: {
          paypalTransactionId: txn.transaction_info.transaction_id,
          paypalStatus: txn.transaction_info.transaction_status,
        },
        createdAt: new Date().toISOString(),
      };
      return this.repository.insertPaymentTransaction(record);
    }

    // Cannot be `private` — TS4094 fires when the mixin's anonymous class
    // is re-exported through the composed LifeOpsService.
    async upsertPlaidTransaction(args: {
      sourceId: string;
      transaction: PlaidTransactionDto;
    }): Promise<boolean> {
      const txn = args.transaction;
      // Plaid `amount` convention: positive = money OUT (debit), negative =
      // money IN (credit/refund). Our schema stores the absolute USD amount
      // and a `direction` enum.
      const direction = txn.amount >= 0 ? "debit" : "credit";
      const merchantRaw = (txn.merchant_name ?? txn.name ?? "").trim();
      const merchantNormalized = normalizeMerchant(merchantRaw);
      const category =
        txn.personal_finance_category?.detailed ??
        txn.personal_finance_category?.primary ??
        txn.category?.[0] ??
        null;
      const record: LifeOpsPaymentTransaction = {
        id: crypto.randomUUID(),
        agentId: this.agentId(),
        sourceId: args.sourceId,
        externalId: txn.transaction_id,
        postedAt: txn.authorized_date
          ? `${txn.authorized_date}T00:00:00.000Z`
          : `${txn.date}T00:00:00.000Z`,
        amountUsd: Number(Math.abs(txn.amount).toFixed(2)),
        direction,
        merchantRaw,
        merchantNormalized,
        description: txn.name ?? null,
        category,
        currency: txn.iso_currency_code ?? "USD",
        metadata: {
          accountId: txn.account_id,
          pending: txn.pending,
          plaidTransactionId: txn.transaction_id,
        },
        createdAt: new Date().toISOString(),
      };
      return this.repository.insertPaymentTransaction(record);
    }
  }

  return LifeOpsPaymentsMixin;
}
