// @ts-nocheck — mixin: type safety is enforced on the composed class
import crypto from "node:crypto";
import { findLifeOpsSubscriptionPlaybook } from "./subscriptions-playbooks.js";
import {
  PlaidManagedClient,
  PlaidManagedClientError,
  type PlaidTransactionDto,
} from "./plaid-managed-client.js";
import {
  parseTransactionsCsv,
  type ParsedCsvTransaction,
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
  LifeOpsPaymentTransaction,
  LifeOpsPaymentsDashboard,
  LifeOpsRecurringCharge,
  LifeOpsSpendingCategoryBreakdown,
  LifeOpsSpendingSummary,
  ListTransactionsRequest,
  SpendingSummaryRequest,
} from "./payment-types.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import {
  fail,
  normalizeOptionalString,
  requireNonEmptyString,
} from "./service-normalize.js";

const DEFAULT_WINDOW_DAYS = 30;
const MS_PER_DAY = 86_400_000;
const VALID_SOURCE_KINDS: readonly LifeOpsPaymentSourceKind[] = [
  "csv",
  "plaid",
  "manual",
  "paypal",
];

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
  const categoryTotals = new Map<
    string,
    { total: number; count: number }
  >();
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
      return this.repository.listPaymentSources(this.agentId());
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
        const didInsert = await this.repository.insertPaymentTransaction(record);
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

    async getRecurringCharges(args: {
      sourceId?: string | null;
      sinceDays?: number | null;
    } = {}): Promise<LifeOpsRecurringCharge[]> {
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

    async getPaymentsDashboard(args: {
      windowDays?: number | null;
    } = {}): Promise<LifeOpsPaymentsDashboard> {
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
      const [sources, recurring, spending] = await Promise.all([
        this.listPaymentSources(),
        this.getRecurringCharges({}),
        this.getSpendingSummary({ windowDays }),
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
        gmailSubscriptionAuditId: latestAudit?.id ?? null,
        generatedAt: new Date().toISOString(),
      };
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
    // access_token. Cloud routes live at /api/v1/milady/plaid/*.
    // -----------------------------------------------------------------------

    private getPlaidManagedClient(): PlaidManagedClient {
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
      const publicToken = requireNonEmptyString(args.publicToken, "publicToken");
      let result;
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
        accountMask: result.institution.primaryAccountMask?.slice(0, 16) ?? null,
        status: "active",
        lastSyncedAt: null,
        transactionCount: 0,
        metadata: {
          plaid: {
            // Storing the access_token in source metadata is required for
            // sync. The cloud already authorized this Item to the user;
            // local storage is encrypted at rest by the underlying database
            // adapter.
            accessToken: result.accessToken,
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
          | { accessToken?: string; cursor?: string }
          | undefined) ?? null;
      const accessToken = plaidMetadata?.accessToken;
      if (typeof accessToken !== "string" || accessToken.length === 0) {
        fail(409, "Plaid source is missing an access token. Re-link the account.");
      }
      const cursor = plaidMetadata?.cursor ?? "";

      let cumulativeInserted = 0;
      let cumulativeSkipped = 0;
      let pageCursor = cursor;
      let hasMore = true;
      let pageGuard = 0;
      while (hasMore && pageGuard < 20) {
        let delta;
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

    private async upsertPlaidTransaction(args: {
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
