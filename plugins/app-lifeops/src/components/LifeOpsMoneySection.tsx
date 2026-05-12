import {
  type CloudBillingHistoryItem,
  client,
  useApp,
} from "@elizaos/ui";
import {
  Ban,
  CalendarClock,
  CheckCircle2,
  CreditCard,
  DollarSign,
  FilePlus2,
  Loader2,
  MessageCircle,
  RefreshCw,
  Sparkles,
  Timer,
  Trash2,
  TrendingDown,
  Upload,
} from "lucide-react";
import { type JSX, useCallback, useEffect, useMemo, useState } from "react";
import type {
  LifeOpsPaymentSource,
  LifeOpsPaymentsDashboard,
  LifeOpsRecurringCharge,
  LifeOpsUpcomingBill,
} from "../lifeops/payment-types.js";
import { useLifeOpsChatLauncher } from "./LifeOpsChatAdapter.js";
import { LifeOpsLinkBankButton } from "./LifeOpsLinkBankButton.js";
import { LifeOpsLinkPaypalButton } from "./LifeOpsLinkPaypalButton.js";

function formatUsd(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "Needs date";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

const RELATIVE_TIME_UNITS: Array<{
  unit: Intl.RelativeTimeFormatUnit;
  ms: number;
}> = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
];

function formatRelative(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso.slice(0, 10);
  const diffMs = ts - Date.now();
  const absMs = Math.abs(diffMs);
  if (absMs < 30_000) return "just now";
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const { unit, ms } of RELATIVE_TIME_UNITS) {
    if (absMs >= ms) {
      return formatter.format(Math.round(diffMs / ms), unit);
    }
  }
  return formatter.format(Math.round(diffMs / 1000), "second");
}

function formatDueRelative(dueDateIso: string | null): string {
  if (!dueDateIso) return "review date";
  // dueDateIso is YYYY-MM-DD; treat as UTC noon to avoid TZ-shift edge cases.
  const due = new Date(`${dueDateIso}T12:00:00.000Z`).getTime();
  if (!Number.isFinite(due)) return dueDateIso;
  const today = new Date();
  const todayUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
    12,
  );
  const diffDays = Math.round((due - todayUtc) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return "due today";
  if (diffDays === 1) return "due tomorrow";
  if (diffDays > 1) return `due in ${diffDays}d`;
  return `${Math.abs(diffDays)}d overdue`;
}

function formatCredits(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function billStatusLabel(bill: LifeOpsUpcomingBill): string {
  switch (bill.status) {
    case "overdue":
      return "Overdue";
    case "needs_due_date":
      return "Review date";
    case "upcoming":
      return formatDueRelative(bill.dueDate);
  }
}

function cadenceLabel(cadence: LifeOpsRecurringCharge["cadence"]): string {
  switch (cadence) {
    case "weekly":
      return "Weekly";
    case "biweekly":
      return "Every 2 weeks";
    case "monthly":
      return "Monthly";
    case "quarterly":
      return "Quarterly";
    case "annual":
      return "Annual";
    case "irregular":
      return "Irregular";
  }
}

export function LifeOpsMoneySection(): JSX.Element | null {
  const [dashboard, setDashboard] = useState<LifeOpsPaymentsDashboard | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const { openLifeOpsChat } = useLifeOpsChatLauncher();

  const {
    elizaCloudConnected,
    elizaCloudCredits,
    elizaCloudCreditsLow,
    elizaCloudCreditsCritical,
    setTab,
  } = useApp();

  const [creditTransactions, setCreditTransactions] = useState<
    CloudBillingHistoryItem[] | null
  >(null);
  const [creditTransactionsLoading, setCreditTransactionsLoading] =
    useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const dash = await client.getLifeOpsPaymentsDashboard({ windowDays: 30 });
      setDashboard(dash);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshCreditTransactions = useCallback(async () => {
    if (!elizaCloudConnected) {
      setCreditTransactions(null);
      return;
    }
    setCreditTransactionsLoading(true);
    try {
      const result = await client.getCloudBillingHistory();
      const list =
        result.data ??
        result.items ??
        result.history ??
        ([] as CloudBillingHistoryItem[]);
      setCreditTransactions(list);
    } catch {
      // 401/404/network → no data yet, keep section quiet rather than erroring loudly.
      setCreditTransactions([]);
    } finally {
      setCreditTransactionsLoading(false);
    }
  }, [elizaCloudConnected]);

  useEffect(() => {
    void refreshCreditTransactions();
  }, [refreshCreditTransactions]);

  const onAddSource = useCallback(async () => {
    const label = window.prompt(
      "Source label (e.g. 'Chase Checking', 'Amex'):",
    );
    if (!label) return;
    const kindAnswer = window.prompt(
      "Source kind — csv / manual / plaid / paypal:",
      "csv",
    );
    const kind = (kindAnswer ?? "csv").trim().toLowerCase();
    if (!["csv", "manual", "plaid", "paypal"].includes(kind)) {
      window.alert("Invalid kind.");
      return;
    }
    const institution =
      window.prompt("Institution (optional):", "") ?? undefined;
    try {
      await client.addLifeOpsPaymentSource({
        kind: kind as LifeOpsPaymentSource["kind"],
        label,
        institution:
          institution && institution.trim().length > 0 ? institution : null,
      });
      await refresh();
    } catch (err) {
      window.alert(
        `Failed to add source: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [refresh]);

  const onImportCsv = useCallback(
    async (source: LifeOpsPaymentSource) => {
      const csvText = window.prompt(
        `Paste CSV content for "${source.label}" (first row = header):`,
      );
      if (!csvText || csvText.trim().length === 0) return;
      setImportStatus(`Importing CSV into ${source.label}…`);
      try {
        const result = await client.importLifeOpsPaymentCsv({
          sourceId: source.id,
          csvText,
        });
        setImportStatus(
          `Imported ${result.inserted} new transactions (${result.skipped} already on file${
            result.errors.length > 0 ? `, ${result.errors.length} errors` : ""
          }).`,
        );
        await refresh();
      } catch (err) {
        setImportStatus(null);
        window.alert(
          `CSV import failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [refresh],
  );

  const onDeleteSource = useCallback(
    async (source: LifeOpsPaymentSource) => {
      if (
        !window.confirm(
          `Delete source "${source.label}"? This removes its transactions too.`,
        )
      ) {
        return;
      }
      try {
        await client.deleteLifeOpsPaymentSource(source.id);
        await refresh();
      } catch (err) {
        window.alert(
          `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [refresh],
  );

  const onSyncPlaid = useCallback(
    async (source: LifeOpsPaymentSource) => {
      setImportStatus(`Syncing ${source.label} via Plaid…`);
      try {
        const result = await client.syncLifeOpsPlaidTransactions({
          sourceId: source.id,
        });
        setImportStatus(
          `Plaid sync: ${result.inserted} new transaction${result.inserted === 1 ? "" : "s"} (${result.skipped} already on file).`,
        );
        await refresh();
      } catch (err) {
        setImportStatus(null);
        window.alert(
          `Plaid sync failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [refresh],
  );

  const onSyncPaypal = useCallback(
    async (source: LifeOpsPaymentSource) => {
      setImportStatus(`Syncing ${source.label} via PayPal…`);
      try {
        const result = await client.syncLifeOpsPaypalTransactions({
          sourceId: source.id,
          windowDays: 90,
        });
        if (result.fallback === "csv_export") {
          setImportStatus(
            "PayPal Reporting API isn't available for this account (typically personal-tier). Use the CSV export from paypal.com → Activity → Statements.",
          );
        } else {
          setImportStatus(
            `PayPal sync: ${result.inserted} new transaction${result.inserted === 1 ? "" : "s"} (${result.skipped} already on file).`,
          );
        }
        await refresh();
      } catch (err) {
        setImportStatus(null);
        window.alert(
          `PayPal sync failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [refresh],
  );

  const onScanGmail = useCallback(async () => {
    try {
      const result = await client.scanLifeOpsEmailSubscriptions();
      window.alert(
        `Scan complete. ${result.summary.uniqueSenderCount} senders found (${result.summary.oneClickEligibleCount} one-click eligible).`,
      );
    } catch (err) {
      window.alert(
        `Scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, []);

  const onChatAboutRecurringCharge = useCallback(
    (charge: LifeOpsRecurringCharge) => {
      openLifeOpsChat(
        [
          `Help me review this recurring charge from ${charge.merchantDisplay}.`,
          `Cadence: ${cadenceLabel(charge.cadence)}.`,
          `Average charge: ${formatUsd(charge.averageAmountUsd)}.`,
          `Annualized cost: ${formatUsd(charge.annualizedCostUsd)}.`,
          `Last charged: ${formatDate(charge.latestSeenAt)}.`,
          "If it makes sense, prepare the cancellation steps before doing anything destructive.",
        ].join(" "),
      );
    },
    [openLifeOpsChat],
  );

  const onCancelRecurringCharge = useCallback(
    async (charge: LifeOpsRecurringCharge, playbookKey: string) => {
      try {
        const summary = (await client.cancelLifeOpsSubscription({
          serviceSlug: playbookKey,
          executor: "user_browser",
          confirmed: false,
        })) as {
          cancellation: {
            status: string;
            serviceName: string;
            error?: string;
            managementUrl?: string | null;
          };
        };
        const status = summary.cancellation.status;
        if (status === "completed" || status === "already_canceled") {
          window.alert(
            `${summary.cancellation.serviceName} cancellation: ${status.replace("_", " ")}.`,
          );
          await refresh();
          return;
        }
        if (
          status === "awaiting_confirmation" ||
          status === "needs_login" ||
          status === "needs_mfa" ||
          status === "phone_only" ||
          status === "chat_only" ||
          status === "blocked"
        ) {
          openLifeOpsChat(
            [
              `Cancellation for ${charge.merchantDisplay} is in state "${status}".`,
              "Continue in chat — I'll guide you through the next step (login, MFA, retention prompts, or phone/chat handoff).",
            ].join(" "),
          );
          return;
        }
        if (status === "failed" || status === "unsupported_surface") {
          // PLAYBOOK_NOT_IMPLEMENTED comes through as `failed` with the error
          // string carrying the prefix and the managementUrl populated. Open
          // the management page in a new tab so the user can finish manually.
          const error = summary.cancellation.error ?? "";
          const url = summary.cancellation.managementUrl;
          if (error.includes("PLAYBOOK_NOT_IMPLEMENTED") && url) {
            window.open(url, "_blank", "noopener");
            return;
          }
          window.alert(`Cancellation could not start: ${error || status}`);
          return;
        }
      } catch (err) {
        window.alert(
          `Cancellation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [openLifeOpsChat, refresh],
  );

  const onMarkBillPaid = useCallback(
    async (bill: LifeOpsUpcomingBill) => {
      try {
        await client.markLifeOpsBillPaid({ billId: bill.id });
        await refresh();
      } catch (err) {
        window.alert(
          `Mark paid failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [refresh],
  );

  const onSnoozeBill = useCallback(
    async (bill: LifeOpsUpcomingBill) => {
      try {
        await client.snoozeLifeOpsBill({ billId: bill.id, days: 7 });
        await refresh();
      } catch (err) {
        window.alert(
          `Snooze failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [refresh],
  );

  const onChatAboutBill = useCallback(
    (bill: LifeOpsUpcomingBill) => {
      openLifeOpsChat(
        [
          `Help me look at this bill from ${bill.merchant}.`,
          `Amount: ${formatUsd(bill.amountUsd)} ${bill.currency}.`,
          `Due: ${bill.dueDate ?? "needs review"} (${billStatusLabel(bill)}).`,
          "What should I do about it?",
        ].join(" "),
      );
    },
    [openLifeOpsChat],
  );

  const playbookHitsByMerchant = useMemo(() => {
    const map = new Map<string, string>();
    if (!dashboard?.recurringPlaybookHits) return map;
    for (const hit of dashboard.recurringPlaybookHits) {
      map.set(hit.merchantNormalized, hit.playbookKey);
    }
    return map;
  }, [dashboard]);

  const annualRecurring = useMemo(() => {
    if (!dashboard) return 0;
    return dashboard.recurring.reduce(
      (total, charge) => total + charge.annualizedCostUsd,
      0,
    );
  }, [dashboard]);

  if (loading && !dashboard) {
    return (
      <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading money dashboard…
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3 p-6">
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex items-center gap-2 rounded-md border border-border/30 bg-bg-muted/30 px-3 py-1.5 text-xs font-medium text-txt hover:bg-bg-muted/60"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </button>
      </div>
    );
  }

  const dash = dashboard;
  if (!dash) return null;

  return (
    <div
      className="flex h-full w-full flex-col gap-4 p-4"
      data-testid="lifeops-money-section"
    >
      <header className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-base font-semibold">
            <CreditCard className="h-4 w-4" aria-hidden /> Money
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void onScanGmail()}
            aria-label="Scan Gmail for subscription senders"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/30 bg-bg-muted/30 text-muted hover:bg-bg-muted/60 hover:text-txt"
            title="Scan Gmail for subscription senders"
          >
            <Upload className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => {
              void refresh();
              void refreshCreditTransactions();
            }}
            aria-label="Refresh dashboard"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/30 bg-bg-muted/30 text-muted hover:bg-bg-muted/60 hover:text-txt"
            title="Refresh dashboard"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </header>

      {importStatus ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          {importStatus}
        </div>
      ) : null}

      <CloudCreditsBalance
        connected={elizaCloudConnected}
        balance={elizaCloudCredits}
        low={elizaCloudCreditsLow}
        critical={elizaCloudCreditsCritical}
        onOpenSettings={() => setTab("settings")}
      />

      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Kpi
          label={`Last ${dash.spending.windowDays}d spend`}
          value={formatUsd(dash.spending.totalSpendUsd)}
          icon={<TrendingDown className="h-4 w-4" aria-hidden />}
        />
        <Kpi
          label="Monthly recurring"
          value={formatUsd(dash.spending.recurringSpendUsd)}
          icon={<CreditCard className="h-4 w-4" aria-hidden />}
        />
        <Kpi
          label="Annualized recurring"
          value={formatUsd(annualRecurring)}
          icon={<DollarSign className="h-4 w-4" aria-hidden />}
        />
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <section className="rounded-lg border border-border/20 bg-bg/30 p-3">
            <header className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Sources</h2>
              <div className="flex flex-wrap items-center gap-1.5">
                <LifeOpsLinkBankButton onLinked={() => void refresh()} />
                <LifeOpsLinkPaypalButton onLinked={() => void refresh()} />
                <button
                  type="button"
                  onClick={() => void onAddSource()}
                  aria-label="Add a source manually"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border/30 bg-bg-muted/30 text-muted hover:bg-bg-muted/60 hover:text-txt"
                  title="Add a source manually (CSV / manual)"
                >
                  <FilePlus2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            </header>
            {dash.sources.length === 0 ? (
              <p className="text-xs text-muted">No sources.</p>
            ) : (
              <ul className="space-y-2">
                {dash.sources.map((source) => (
                  <li
                    key={source.id}
                    className="flex items-center justify-between gap-2 rounded border border-border/20 bg-bg/40 px-3 py-2 text-xs"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border/20 bg-bg-muted/30 font-mono text-[10px] uppercase text-muted">
                        {source.kind.slice(0, 2)}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-txt">
                          {source.label}
                        </div>
                        <div className="truncate text-[11px] text-muted">
                          {source.institution ??
                            (source.lastSyncedAt
                              ? formatDate(source.lastSyncedAt)
                              : `${source.transactionCount} tx`)}
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {source.kind === "csv" ? (
                        <button
                          type="button"
                          onClick={() => void onImportCsv(source)}
                          aria-label={`Import CSV for ${source.label}`}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border/30 bg-bg-muted/30 text-muted hover:bg-bg-muted/60 hover:text-txt"
                          title="Import CSV"
                        >
                          <Upload className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      ) : null}
                      {source.kind === "plaid" ? (
                        <button
                          type="button"
                          onClick={() => void onSyncPlaid(source)}
                          aria-label={`Sync ${source.label}`}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border/30 bg-bg-muted/30 text-muted hover:bg-bg-muted/60 hover:text-txt"
                          title="Pull the latest transactions from Plaid"
                        >
                          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      ) : null}
                      {source.kind === "paypal" ? (
                        <button
                          type="button"
                          onClick={() => void onSyncPaypal(source)}
                          aria-label={`Sync ${source.label}`}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border/30 bg-bg-muted/30 text-muted hover:bg-bg-muted/60 hover:text-txt"
                          title="Pull recent PayPal transactions (Reporting API)"
                        >
                          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void onDeleteSource(source)}
                        aria-label={`Remove ${source.label}`}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-bg-muted/40 hover:text-rose-300"
                        title="Remove source"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-border/20 bg-bg/30 p-3">
            <h2 className="mb-2 text-sm font-semibold">Top categories</h2>
            {dash.spending.topCategories.length === 0 ? (
              <p className="text-xs text-muted">No categories.</p>
            ) : (
              <ul className="space-y-1.5">
                {dash.spending.topCategories.map((category) => (
                  <li
                    key={category.category}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="truncate text-txt/85">
                      {category.category}
                    </span>
                    <span className="tabular-nums text-muted">
                      {formatUsd(category.totalUsd)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <CloudCreditsActivity
          connected={elizaCloudConnected}
          loading={creditTransactionsLoading}
          transactions={creditTransactions}
        />
      </div>

      <section
        className="rounded-lg border border-border/20 bg-bg/30 p-3"
        data-testid="lifeops-money-bills"
      >
        <header className="mb-2 flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <CalendarClock className="h-3.5 w-3.5" aria-hidden /> Bills from
            email
          </h2>
        </header>
        {(dash.upcomingBills ?? []).length === 0 ? (
          <p className="text-xs text-muted">
            No bills detected from email yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {(dash.upcomingBills ?? []).map((bill) => (
              <li
                key={bill.id}
                className="flex items-center justify-between gap-2 rounded border border-border/10 bg-bg/40 px-2.5 py-1.5 text-xs"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-txt">
                    {bill.merchant}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
                    <span>{formatDate(bill.dueDate)}</span>
                    <span
                      className={[
                        "rounded px-1.5 py-0.5 font-mono text-[10px]",
                        bill.status === "overdue"
                          ? "bg-rose-500/15 text-rose-200"
                          : bill.status === "needs_due_date"
                            ? "bg-amber-500/15 text-amber-200"
                            : "bg-bg-muted/40",
                      ].join(" ")}
                    >
                      {billStatusLabel(bill)}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="tabular-nums font-semibold text-amber-300">
                    {formatUsd(bill.amountUsd)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void onMarkBillPaid(bill)}
                    aria-label={`Mark ${bill.merchant} paid`}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20"
                    title="Mark this bill as paid"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => void onSnoozeBill(bill)}
                    aria-label={`Snooze ${bill.merchant} one week`}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border/30 bg-bg-muted/30 text-muted hover:bg-bg-muted/60 hover:text-txt"
                    title="Push the due date out a week"
                  >
                    <Timer className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => onChatAboutBill(bill)}
                    aria-label={`Open chat about ${bill.merchant}`}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border/30 bg-bg-muted/30 text-muted hover:bg-bg-muted/60 hover:text-txt"
                    title="Open chat about this bill"
                  >
                    <MessageCircle className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-border/20 bg-bg/30 p-3">
        <header className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Recurring charges</h2>
        </header>
        {dash.recurring.length === 0 ? (
          <p className="text-xs text-muted">No recurring charges.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead className="text-left text-[11px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Merchant</th>
                  <th className="py-1.5 pr-3 font-medium">Cadence</th>
                  <th className="py-1.5 pr-3 text-right font-medium">
                    Typical
                  </th>
                  <th className="py-1.5 pr-3 text-right font-medium">
                    Annualized
                  </th>
                  <th className="py-1.5 pr-3 font-medium">Last charged</th>
                  <th className="py-1.5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {dash.recurring.map((charge) => (
                  <tr
                    key={charge.merchantNormalized}
                    className="border-t border-border/10"
                  >
                    <td className="py-1.5 pr-3 font-medium text-txt">
                      {charge.merchantDisplay}
                    </td>
                    <td className="py-1.5 pr-3 text-muted">
                      {cadenceLabel(charge.cadence)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {formatUsd(charge.averageAmountUsd)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums font-semibold text-rose-300">
                      {formatUsd(charge.annualizedCostUsd)}
                    </td>
                    <td className="py-1.5 pr-3 text-muted">
                      {formatDate(charge.latestSeenAt)}
                    </td>
                    <td className="py-1.5 text-muted">
                      {(() => {
                        const playbookKey = playbookHitsByMerchant.get(
                          charge.merchantNormalized,
                        );
                        if (playbookKey) {
                          return (
                            <button
                              type="button"
                              onClick={() =>
                                void onCancelRecurringCharge(
                                  charge,
                                  playbookKey,
                                )
                              }
                              aria-label={`Cancel ${charge.merchantDisplay}`}
                              className="mr-1 inline-flex h-7 w-7 items-center justify-center rounded-full border border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20"
                              title={`Open the cancellation flow for ${charge.merchantDisplay}`}
                            >
                              <Ban className="h-3.5 w-3.5" aria-hidden />
                            </button>
                          );
                        }
                        return null;
                      })()}
                      <button
                        type="button"
                        onClick={() => onChatAboutRecurringCharge(charge)}
                        aria-label={`Open chat about ${charge.merchantDisplay}`}
                        className="mr-1 inline-flex h-7 w-7 items-center justify-center rounded-full border border-border/30 bg-bg-muted/30 text-muted hover:bg-bg-muted/60 hover:text-txt"
                        title="Open chat with this recurring charge attached"
                      >
                        <MessageCircle className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dash.spending.topMerchants.length > 0 ? (
        <section className="rounded-lg border border-border/20 bg-bg/30 p-3">
          <h2 className="mb-2 text-sm font-semibold">Top merchants</h2>
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {dash.spending.topMerchants.map((merchant) => (
              <li
                key={merchant.merchantNormalized}
                className="flex items-center justify-between rounded border border-border/10 bg-bg/40 px-2 py-1 text-xs"
              >
                <span className="truncate text-txt/85">
                  {merchant.merchantDisplay}
                </span>
                <span className="tabular-nums text-muted">
                  {formatUsd(merchant.totalUsd)} · {merchant.transactionCount}×
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 text-[11px] text-muted">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Refreshing…
        </div>
      ) : null}
    </div>
  );
}

function Kpi(props: {
  label: string;
  value: string;
  icon: JSX.Element;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-border/20 bg-bg/30 px-3 py-3">
      <div className="flex items-center gap-2 text-[11px] text-muted">
        {props.icon}
        <span>{props.label}</span>
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">
        {props.value}
      </div>
    </div>
  );
}

function CloudCreditsBalance(props: {
  connected: boolean;
  balance: number | null;
  low: boolean;
  critical: boolean;
  onOpenSettings: () => void;
}): JSX.Element {
  if (!props.connected) {
    return (
      <section className="flex items-center justify-between gap-3 rounded-lg border border-border/20 bg-bg/30 px-4 py-3 text-xs text-muted">
        <span className="inline-flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          Eliza Cloud
        </span>
        <button
          type="button"
          onClick={props.onOpenSettings}
          className="font-medium text-txt underline-offset-2 hover:underline"
        >
          Settings
        </button>
      </section>
    );
  }

  const showLoading = props.balance === null;
  const accentColor = props.critical
    ? "text-rose-300"
    : props.low
      ? "text-amber-300"
      : "text-emerald-300";

  return (
    <section
      className="flex items-center justify-between gap-4 rounded-lg border border-border/20 bg-bg/40 px-4 py-3"
      title="Eliza Cloud balance"
    >
      <div className="flex items-center gap-3">
        <div className="rounded-md border border-border/30 bg-bg-muted/30 p-2 text-txt/80">
          <Sparkles className="h-4 w-4" aria-hidden />
        </div>
        <div>
          {showLoading ? (
            <div className="mt-1 h-6 w-32 animate-pulse rounded bg-bg-muted/40" />
          ) : (
            <div
              className={`text-2xl font-semibold tabular-nums ${accentColor}`}
            >
              {formatCredits(props.balance ?? 0)}
            </div>
          )}
        </div>
      </div>
      {props.low && !showLoading ? (
        <span
          className="h-2.5 w-2.5 rounded-full bg-amber-300 shadow-[0_0_0_3px_rgba(245,158,11,0.18)]"
          title="Low balance"
        />
      ) : null}
    </section>
  );
}

function CloudCreditsActivity(props: {
  connected: boolean;
  loading: boolean;
  transactions: CloudBillingHistoryItem[] | null;
}): JSX.Element | null {
  if (!props.connected) return null;

  const recent = (props.transactions ?? []).slice(0, 10);

  return (
    <section className="rounded-lg border border-border/20 bg-bg/30 p-3">
      <header className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Credits</h2>
        {props.loading ? (
          <Loader2
            className="h-3.5 w-3.5 animate-spin text-muted"
            aria-hidden
          />
        ) : null}
      </header>
      {recent.length === 0 ? (
        <p className="text-xs text-muted">
          {props.loading ? "Loading…" : "No recent activity"}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {recent.map((txn) => {
            const isCredit = txn.amount >= 0;
            return (
              <li
                key={txn.id}
                className="flex items-center justify-between gap-2 rounded border border-border/10 bg-bg/40 px-2.5 py-1.5 text-xs"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-txt/90">
                    {txn.description ?? (isCredit ? "Top-up" : "Usage")}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted">
                    {formatRelative(txn.createdAt)}
                  </div>
                </div>
                <span
                  className={`shrink-0 tabular-nums font-semibold ${
                    isCredit ? "text-emerald-300" : "text-rose-300"
                  }`}
                >
                  {isCredit ? "+" : "−"}
                  {formatCredits(Math.abs(txn.amount))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
