import { client } from "@elizaos/app-core";
import {
  CreditCard,
  DollarSign,
  FilePlus2,
  Loader2,
  RefreshCw,
  Trash2,
  TrendingDown,
  Upload,
} from "lucide-react";
import { type JSX, useCallback, useEffect, useMemo, useState } from "react";
import type {
  LifeOpsPaymentSource,
  LifeOpsPaymentsDashboard,
  LifeOpsRecurringCharge,
} from "../lifeops/payment-types.js";
import { useLifeOpsChatLauncher } from "./LifeOpsChatAdapter.js";

function formatUsd(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDate(iso: string): string {
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

export function LifeOpsPaymentsSection(): JSX.Element | null {
  const [dashboard, setDashboard] = useState<LifeOpsPaymentsDashboard | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const { openLifeOpsChat } = useLifeOpsChatLauncher();

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
        Loading payments dashboard…
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
    <div className="flex h-full w-full flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-base font-semibold">
            <CreditCard className="h-4 w-4" aria-hidden /> Payments &amp;
            Subscriptions
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void onScanGmail()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/30 bg-bg-muted/30 px-2.5 py-1 text-xs font-medium hover:bg-bg-muted/60"
            title="Scan Gmail for subscription senders"
          >
            <Upload className="h-3.5 w-3.5" /> Scan Gmail
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/30 bg-bg-muted/30 px-2.5 py-1 text-xs font-medium hover:bg-bg-muted/60"
            title="Refresh dashboard"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      </header>

      {importStatus ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          {importStatus}
        </div>
      ) : null}

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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-border/20 bg-bg/30 p-3">
          <header className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Sources</h2>
            <button
              type="button"
              onClick={() => void onAddSource()}
              className="inline-flex items-center gap-1 rounded-md border border-border/30 bg-bg-muted/30 px-2 py-0.5 text-xs font-medium hover:bg-bg-muted/60"
            >
              <FilePlus2 className="h-3 w-3" /> Add
            </button>
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
                  <div className="min-w-0">
                    <div className="truncate font-medium text-txt">
                      {source.label}
                      <span className="ml-2 rounded bg-bg-muted/40 px-1.5 py-0.5 text-[10px] font-mono text-muted">
                        {source.kind}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted">
                      {source.institution ?? "—"} · {source.transactionCount}{" "}
                      transactions
                      {source.lastSyncedAt
                        ? ` · last sync ${formatDate(source.lastSyncedAt)}`
                        : " · never synced"}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {source.kind === "csv" ? (
                      <button
                        type="button"
                        onClick={() => void onImportCsv(source)}
                        className="rounded-md border border-border/30 bg-bg-muted/30 px-2 py-0.5 text-[11px] hover:bg-bg-muted/60"
                      >
                        Import CSV
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void onDeleteSource(source)}
                      className="rounded-md p-1 text-muted hover:bg-bg-muted/40 hover:text-rose-300"
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
                      <button
                        type="button"
                        onClick={() => onChatAboutRecurringCharge(charge)}
                        className="mr-1 rounded border border-border/30 bg-bg-muted/30 px-2 py-0.5 text-[11px] hover:bg-bg-muted/60"
                        title="Open chat with this recurring charge attached"
                      >
                        Chat
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
