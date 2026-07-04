/**
 * Shared type definitions for the finance dashboard surface: currency code,
 * transaction-status / recurring-cadence enums, and the transaction /
 * recurring-charge / balance-summary DTOs the FinancesView renders.
 */

/** Currency code in ISO 4217 form (e.g. "USD"). */
export type CurrencyCode = string;

/** Status values a transaction row can hold. */
export const TRANSACTION_STATUSES = [
  "pending",
  "posted",
  "void",
  "refunded",
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/** Cadence options for a recurring charge. */
export const RECURRING_CADENCES = [
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
] as const;
export type RecurringCadence = (typeof RECURRING_CADENCES)[number];

/** DTO surfaced to the FinancesView for one transaction row. */
export interface FinanceTransactionDTO {
  id: string;
  occurredAt: string;
  amountMinor: number;
  currency: CurrencyCode;
  description: string;
  category: string | null;
  merchant: string | null;
  status: TransactionStatus;
  source: string | null;
}

/** DTO surfaced to the FinancesView for one recurring-charge row. */
export interface RecurringChargeDTO {
  id: string;
  label: string;
  amountMinor: number;
  currency: CurrencyCode;
  cadence: RecurringCadence;
  nextChargeAt: string | null;
  merchant: string | null;
  active: boolean;
}

/** Aggregate balance summary shown at the top of the finances dashboard. */
export interface FinanceBalanceSummaryDTO {
  netBalanceMinor: number;
  currency: CurrencyCode;
  monthlyIncomeMinor: number;
  monthlyOutflowMinor: number;
  asOf: string;
}

/** Props for the FinancesView React component (the dashboard surface). */
export interface FinancesViewProps {
  balance?: FinanceBalanceSummaryDTO;
  transactions?: FinanceTransactionDTO[];
  recurring?: RecurringChargeDTO[];
}
