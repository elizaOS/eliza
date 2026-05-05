export type LifeOpsPaymentSourceKind =
  | "csv"
  | "plaid"
  | "manual"
  | "paypal"
  | "email";

export type LifeOpsPaymentSourceStatus =
  | "active"
  | "disconnected"
  | "needs_attention";

export interface LifeOpsPaymentSource {
  id: string;
  agentId: string;
  kind: LifeOpsPaymentSourceKind;
  label: string;
  institution: string | null;
  accountMask: string | null;
  status: LifeOpsPaymentSourceStatus;
  lastSyncedAt: string | null;
  transactionCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type LifeOpsPaymentDirection = "debit" | "credit";

export interface LifeOpsPaymentTransaction {
  id: string;
  agentId: string;
  sourceId: string;
  externalId: string | null;
  postedAt: string;
  amountUsd: number;
  direction: LifeOpsPaymentDirection;
  merchantRaw: string;
  merchantNormalized: string;
  description: string | null;
  category: string | null;
  currency: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type LifeOpsRecurringCadence =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "annual"
  | "irregular";

export interface LifeOpsRecurringCharge {
  merchantNormalized: string;
  merchantDisplay: string;
  cadence: LifeOpsRecurringCadence;
  averageAmountUsd: number;
  lastAmountUsd: number;
  annualizedCostUsd: number;
  occurrenceCount: number;
  firstSeenAt: string;
  latestSeenAt: string;
  nextExpectedAt: string | null;
  sourceIds: string[];
  sampleTransactionIds: string[];
  confidence: number;
  category: string | null;
}

export interface LifeOpsSpendingCategoryBreakdown {
  category: string;
  totalUsd: number;
  transactionCount: number;
}

export interface LifeOpsSpendingSummary {
  windowDays: number;
  fromDate: string;
  toDate: string;
  totalSpendUsd: number;
  totalIncomeUsd: number;
  netUsd: number;
  transactionCount: number;
  recurringSpendUsd: number;
  topCategories: LifeOpsSpendingCategoryBreakdown[];
  topMerchants: Array<{
    merchantNormalized: string;
    merchantDisplay: string;
    totalUsd: number;
    transactionCount: number;
  }>;
}

export interface LifeOpsRecurringChargePlaybookHit {
  merchantNormalized: string;
  playbookKey: string;
  serviceName: string;
  managementUrl: string;
  executorPreference: "user_browser" | "agent_browser" | "desktop_native";
}

/**
 * A bill detected from email (or other source) and surfaced on the Money
 * dashboard. Backed by a `life_payment_transactions` row whose
 * `source.kind === "email"` and whose metadata carries bill-specific data.
 */
export type LifeOpsUpcomingBillStatus =
  | "upcoming"
  | "overdue"
  | "needs_due_date";

export interface LifeOpsUpcomingBill {
  id: string;
  merchant: string;
  amountUsd: number;
  currency: string;
  dueDate: string | null;
  status: LifeOpsUpcomingBillStatus;
  postedAt: string;
  sourceMessageId: string | null;
  confidence: number;
}

export interface LifeOpsPaymentsDashboard {
  sources: LifeOpsPaymentSource[];
  recurring: LifeOpsRecurringCharge[];
  /**
   * For every recurring charge whose merchant matches a known cancellation
   * playbook (Netflix, Spotify, NYT, etc.), this map carries the playbook
   * descriptor. UI shows a deep-link "Cancel" button only when there is a hit.
   */
  recurringPlaybookHits: LifeOpsRecurringChargePlaybookHit[];
  spending: LifeOpsSpendingSummary;
  /**
   * Bills extracted from email-classified messages. Includes upcoming bills,
   * overdue bills, and bills that need a reviewed due date.
   */
  upcomingBills: LifeOpsUpcomingBill[];
  gmailSubscriptionAuditId: string | null;
  generatedAt: string;
}

export interface AddPaymentSourceRequest {
  kind: LifeOpsPaymentSourceKind;
  label: string;
  institution?: string | null;
  accountMask?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ImportTransactionsCsvRequest {
  sourceId: string;
  csvText: string;
  /** Optional column hints; auto-detected when absent. */
  dateColumn?: string;
  amountColumn?: string;
  merchantColumn?: string;
  descriptionColumn?: string;
  categoryColumn?: string;
}

export interface ImportTransactionsCsvResult {
  sourceId: string;
  rowsRead: number;
  inserted: number;
  skipped: number;
  errors: string[];
}

export interface ListTransactionsRequest {
  sourceId?: string | null;
  sinceAt?: string | null;
  untilAt?: string | null;
  limit?: number | null;
  merchantContains?: string | null;
  onlyDebits?: boolean | null;
}

export interface SpendingSummaryRequest {
  windowDays?: number | null;
  sourceId?: string | null;
}

// Money is the user-facing name; Payment* types remain for backwards compat.
export type LifeOpsMoneyDashboard = LifeOpsPaymentsDashboard;
export type LifeOpsMoneySource = LifeOpsPaymentSource;
export type LifeOpsMoneySourceKind = LifeOpsPaymentSourceKind;
export type LifeOpsMoneySourceStatus = LifeOpsPaymentSourceStatus;
export type LifeOpsMoneyTransaction = LifeOpsPaymentTransaction;
export type LifeOpsMoneyDirection = LifeOpsPaymentDirection;
export type AddMoneySourceRequest = AddPaymentSourceRequest;
