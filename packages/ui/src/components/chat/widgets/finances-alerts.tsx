/**
 * FINANCES "Bills & Balance" home widget — a glanceable summary of money
 * attention: an overdrawn-balance escalation row plus the next few recurring
 * bills landing within a week. Fetches the same `/api/lifeops/money/*` routes
 * FinancesView reads (dashboard + recurring + sources; transactions skipped),
 * polling quietly while the document is visible. One of the home-attention
 * widget family; publishes escalation/reminder signals into the shared
 * home-attention store to rank itself on the home surface.
 */
import { Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../../api";
import { supportsFullAppShellRoutes } from "../../../api/app-shell-capabilities";
import { useIntervalWhenDocumentVisible } from "../../../hooks";
import { useIsAuthenticated } from "../../../hooks/useAuthStatus";
import { useNow } from "../../../hooks/useNow";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";

const FINANCES_WIDGET_KEY = "finances/finances.alerts";

// Match FinancesView's 30s quiet poll (plugins/plugin-finances/src/components/
// finances/FinancesView.tsx — POLL_INTERVAL_MS).
const FINANCES_REFRESH_INTERVAL_MS = 30_000;

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
    // error-policy:J3 Intl throws on an unknown currency code from the feed —
    // render the amount with a plain suffix instead
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

/** Shallow content equality so an unchanged 30s poll doesn't re-render. */
function financesEqual(
  a: FinancesWidgetData | null,
  b: FinancesWidgetData,
): boolean {
  if (!a) return false;
  if (
    a.hasSource !== b.hasSource ||
    a.netBalanceMinor !== b.netBalanceMinor ||
    a.bills.length !== b.bills.length
  ) {
    return false;
  }
  return a.bills.every((bill, i) => {
    const other = b.bills[i];
    return (
      bill.id === other.id &&
      bill.amountMinor === other.amountMinor &&
      bill.nextChargeAt === other.nextChargeAt
    );
  });
}

function FinancesAlertsWidget({
  spanClassName = "col-span-2 row-span-1",
}: Partial<WidgetProps>) {
  const [data, setData] = useState<FinancesWidgetData | null>(null);
  const nav = useWidgetNavigation();
  // Auth gate (#11084): the widget mounts before the auth probe resolves, so
  // the money polls must stay dormant until the session is authenticated.
  const authenticated = useIsAuthenticated();

  const load = useCallback(async () => {
    if (!authenticated || !supportsFullAppShellRoutes(client.getBaseUrl())) {
      setData(null);
      return;
    }

    try {
      const [dashboard, recurring, sources] = await Promise.all([
        getJson("/api/lifeops/money/dashboard"),
        getJson("/api/lifeops/money/recurring"),
        getJson("/api/lifeops/money/sources"),
      ]);
      const next: FinancesWidgetData = {
        hasSource: parseHasSource(sources),
        netBalanceMinor: parseNetBalanceMinor(dashboard),
        currency: USD,
        bills: parseBills(recurring),
      };
      // Skip the state update (and the re-render) when the poll is unchanged.
      setData((prev) => (financesEqual(prev, next) ? prev : next));
    } catch {
      // error-policy:J4 glance-tile poll — keep the last good snapshot on a
      // transient failure (todo.tsx pattern); the next tick refreshes.
    }
  }, [authenticated]);

  useEffect(() => {
    void load();
  }, [load]);
  useIntervalWhenDocumentVisible(
    () => void load(),
    FINANCES_REFRESH_INTERVAL_MS,
  );

  // `useNow` is 0 on first render (deterministic render path — no Date.now in
  // render) then the live clock, ticking on the poll cadence to drive the
  // "due in N days" math. The `now === 0` first render is held below.
  const now = useNow(FINANCES_REFRESH_INTERVAL_MS);
  const overdrawn = data != null && data.netBalanceMinor < 0;
  const dueSoon = useMemo(
    () => (data && now > 0 ? billsDueWithin7Days(data.bills, now) : []),
    [data, now],
  );
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

  // One high-priority datum, icon-first: overdrawn balance (escalation) wins;
  // otherwise the soonest bill due this week. Tapping opens the Finances view.
  if (overdrawn) {
    const amount = formatMinor(data.netBalanceMinor, data.currency);
    return (
      <div className={`min-w-0 ${spanClassName}`}>
        <HomeWidgetCard
          icon={<Wallet />}
          label="Bills"
          // Atomic: a currency amount must never soft-wrap mid-number
          // ("-$12" / "5.50" read as two figures on half-width mobile cards).
          value={
            <span className="whitespace-nowrap tabular-nums">{amount}</span>
          }
          badge="Overdrawn"
          tone="danger"
          testId="chat-widget-finances-alerts"
          ariaLabel={`Bills: account overdrawn ${amount}. Open Finances.`}
          onActivate={() => nav.openView("/finances", "finances")}
        />
      </div>
    );
  }
  const soonest = dueSoon[0];
  return (
    <div className={`min-w-0 ${spanClassName}`}>
      <HomeWidgetCard
        icon={<Wallet />}
        label="Bills"
        value={soonest.label}
        meta={dueInLabel(soonest.nextChargeAt as string, now)}
        badge={dueSoon.length > 1 ? `${dueSoon.length} due` : undefined}
        tone="warn"
        testId="chat-widget-finances-alerts"
        ariaLabel={`Bills: ${dueSoon.length} due this week, next ${soonest.label} ${dueInLabel(soonest.nextChargeAt as string, now)}. Open Finances.`}
        onActivate={() => nav.openView("/finances", "finances")}
      />
    </div>
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
