import { Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../../api";
import { useIntervalWhenDocumentVisible } from "../../../hooks";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { WidgetSection } from "./shared";

const FINANCES_WIDGET_KEY = "finances/finances.alerts";

// Match FinancesView's 30s quiet poll (plugins/plugin-finances/src/components/
// finances/FinancesView.tsx — POLL_INTERVAL_MS).
const FINANCES_REFRESH_INTERVAL_MS = 30_000;

const MAX_VISIBLE_BILLS = 3;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const USD = "USD";

// The PA money routes return USD floats on the wire (FinancesView.tsx's
// MoneyDashboardWire { spending.netUsd }, MoneySourcesWire { sources[].status },
// MoneyRecurringChargesWire { charges[].{ merchantNormalized, merchantDisplay,
// averageAmountUsd, nextExpectedAt } }). The responses are untrusted network
// input, so each parser below narrows from `unknown` rather than trusting a
// declared wire interface; never import PA types here.

// ---------------------------------------------------------------------------
// Display model — minor units, mirroring the relevant fields of the display
// DTOs in plugins/plugin-finances/src/types.ts (FinanceBalanceSummaryDTO,
// RecurringChargeDTO). Only the fields the widget renders are kept.
// ---------------------------------------------------------------------------

interface FinancesWidgetData {
  hasSource: boolean;
  /** FinanceBalanceSummaryDTO.netBalanceMinor / .currency (types.ts). */
  netBalanceMinor: number;
  currency: string;
  /** RecurringChargeDTO subset: label / amountMinor / currency / nextChargeAt / active. */
  bills: {
    id: string;
    label: string;
    amountMinor: number;
    currency: string;
    nextChargeAt: string | null;
    active: boolean;
  }[];
}

// ---------------------------------------------------------------------------
// Boundary validation — the responses are untrusted network input, so narrow
// each shape before mapping. Anything malformed degrades to empty (no source /
// no bills), which makes the widget render null rather than throw.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function usdToMinor(amountUsd: number): number {
  return Math.round(amountUsd * 100);
}

/** FinancesView maps spending.netUsd -> netBalanceMinor at the USD boundary. */
function parseNetBalanceMinor(dashboard: unknown): number {
  if (!isRecord(dashboard)) return 0;
  const spending = dashboard.spending;
  if (!isRecord(spending) || typeof spending.netUsd !== "number") return 0;
  return usdToMinor(spending.netUsd);
}

/** FinancesView: connected = any source whose status !== "disconnected". */
function parseHasSource(sources: unknown): boolean {
  if (!isRecord(sources) || !Array.isArray(sources.sources)) return false;
  return sources.sources.some(
    (source) =>
      isRecord(source) &&
      typeof source.status === "string" &&
      source.status !== "disconnected",
  );
}

/** Mirror mapRecurring: USD avg -> minor; PA charges are always active. */
function parseBills(recurring: unknown): FinancesWidgetData["bills"] {
  if (!isRecord(recurring) || !Array.isArray(recurring.charges)) return [];
  const bills: FinancesWidgetData["bills"] = [];
  for (const charge of recurring.charges) {
    if (!isRecord(charge)) continue;
    if (typeof charge.averageAmountUsd !== "number") continue;
    const merchantNormalized =
      typeof charge.merchantNormalized === "string"
        ? charge.merchantNormalized
        : "";
    const merchantDisplay =
      typeof charge.merchantDisplay === "string" ? charge.merchantDisplay : "";
    const label = merchantDisplay || merchantNormalized;
    if (!label) continue;
    bills.push({
      id: merchantNormalized || label,
      label,
      amountMinor: usdToMinor(charge.averageAmountUsd),
      currency: USD,
      nextChargeAt:
        typeof charge.nextExpectedAt === "string"
          ? charge.nextExpectedAt
          : null,
      active: true,
    });
  }
  return bills;
}

/**
 * Load-bearing render boundary mirroring FinancesView.formatMinor: minor units
 * (cents) -> grouped currency string. Kept inline (no shared util) to match the
 * View's own formatting.
 */
function formatMinor(amountMinor: number, currency: string): string {
  const value = amountMinor / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

/** Whole-day rounded "due in N days" / "due today" label for a bill. */
function dueInLabel(nextChargeAt: string, now: number): string {
  const due = new Date(nextChargeAt).getTime();
  const days = Math.round((due - now) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "due today";
  if (days === 1) return "due tomorrow";
  return `due in ${days} days`;
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${client.getBaseUrl()}${path}`);
  if (!response.ok) {
    throw new Error(`Money request failed (${response.status}): ${path}`);
  }
  return response.json();
}

function billsDueWithin7Days(
  bills: FinancesWidgetData["bills"],
  now: number,
): FinancesWidgetData["bills"] {
  const weekFromNow = now + WEEK_MS;
  return bills
    .filter((bill) => {
      if (!bill.active || !bill.nextChargeAt) return false;
      const due = new Date(bill.nextChargeAt).getTime();
      return !Number.isNaN(due) && due >= now && due <= weekFromNow;
    })
    .sort((left, right) => {
      const leftDue = new Date(left.nextChargeAt as string).getTime();
      const rightDue = new Date(right.nextChargeAt as string).getTime();
      return leftDue - rightDue;
    });
}

/**
 * FINANCES "Bills & Balance" home widget (#9143). Glanceable summary of money
 * attention: an overdrawn-balance escalation row plus the next few recurring
 * bills landing within a week. Fetches the same `/api/lifeops/money/*` routes
 * FinancesView reads (dashboard + recurring + sources; transactions skipped),
 * polling quietly while the document is visible.
 */
function FinancesAlertsWidget(_props: Partial<WidgetProps>) {
  const [data, setData] = useState<FinancesWidgetData | null>(null);

  const load = useCallback(async () => {
    try {
      const [dashboard, recurring, sources] = await Promise.all([
        getJson("/api/lifeops/money/dashboard"),
        getJson("/api/lifeops/money/recurring"),
        getJson("/api/lifeops/money/sources"),
      ]);
      setData({
        hasSource: parseHasSource(sources),
        netBalanceMinor: parseNetBalanceMinor(dashboard),
        currency: USD,
        bills: parseBills(recurring),
      });
    } catch {
      // Transient/poll failure: keep the last good snapshot (todo.tsx pattern).
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useIntervalWhenDocumentVisible(
    () => void load(),
    FINANCES_REFRESH_INTERVAL_MS,
  );

  const now = Date.now();
  const overdrawn = data != null && data.netBalanceMinor < 0;
  const dueSoon = data ? billsDueWithin7Days(data.bills, now) : [];
  const hasBillsDue = dueSoon.length > 0;

  // Self-signal (#9143): overdrawn floats up at escalation strength, otherwise
  // bills-due-this-week float up at reminder strength; nothing urgent clears it.
  const weight = overdrawn
    ? HOME_SIGNAL_WEIGHTS.escalation
    : hasBillsDue
      ? HOME_SIGNAL_WEIGHTS.reminder
      : null;
  usePublishHomeAttention(FINANCES_WIDGET_KEY, weight);

  // Render nothing while the first load is pending and nothing is cached, when
  // there's no connected source, or when the balance is healthy and no bill is
  // due within 7 days — the home surface must not show empty placeholders.
  if (data == null) return null;
  if (!data.hasSource) return null;
  if (!overdrawn && !hasBillsDue) return null;

  const visibleBills = dueSoon.slice(0, MAX_VISIBLE_BILLS);
  const remainingCount = dueSoon.length - visibleBills.length;

  return (
    <WidgetSection
      title="Bills & Balance"
      icon={<Wallet className="h-4 w-4" />}
      testId="chat-widget-finances-alerts"
    >
      <div className="flex flex-col gap-1">
        {overdrawn ? (
          <div className="flex items-center justify-between gap-2 px-1 py-1">
            <span className="truncate text-xs font-semibold text-danger">
              Overdrawn
            </span>
            <span className="shrink-0 text-xs font-semibold text-danger">
              {formatMinor(data.netBalanceMinor, data.currency)}
            </span>
          </div>
        ) : null}
        {visibleBills.map((bill) => (
          <div
            key={bill.id}
            className="flex items-center justify-between gap-2 px-1 py-1"
          >
            <span className="min-w-0 truncate text-xs font-medium text-txt">
              {bill.label}
            </span>
            <span className="shrink-0 text-2xs text-muted">
              {formatMinor(bill.amountMinor, bill.currency)} •{" "}
              {dueInLabel(bill.nextChargeAt as string, now)}
            </span>
          </div>
        ))}
        {remainingCount > 0 ? (
          <p className="px-1 text-3xs text-muted">
            +{remainingCount} more bill{remainingCount === 1 ? "" : "s"} due
            soon
          </p>
        ) : null}
      </div>
    </WidgetSection>
  );
}

/**
 * Home-slot registration for the finances "Bills & Balance" widget. Wired into
 * the registry centrally (see widgets/registry.ts). `signalKinds` mirror the
 * self-signal kinds this widget publishes (escalation when overdrawn, reminder
 * when bills are due soon).
 */
export const FINANCES_HOME_WIDGET = {
  pluginId: "finances",
  id: "finances.alerts",
  order: 130,
  signalKinds: ["escalation", "reminder"],
  Component: FinancesAlertsWidget,
} as const;

export { FinancesAlertsWidget };
