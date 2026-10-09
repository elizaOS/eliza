/**
 * Read-only creator earnings statement (#22961 / #23022).
 *
 * Creator monetization is retired: creators no longer earn from MCPs or agent
 * markup, and self-serve payouts are closed. This shows the balance frozen at
 * retirement and the current ledger balance from
 * GET /api/v1/earnings/statement. It offers no payout action; frozen balances
 * are settled manually.
 */

"use client";

import { Info } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DashboardLoadingState } from "../../cloud-ui/components/dashboard/route-placeholders";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Card } from "../../components/ui/card";
import { api } from "../lib/api-client";
import { useDocumentTitle } from "../lib/use-document-title";
import { useSessionAuth } from "../lib/use-session-auth";
import { useCloudT } from "../shell/CloudI18nProvider";

export interface CreatorEarningsStatementDto {
  status: "none" | "frozen" | "settled_manually";
  payoutsRetired: true;
  frozen: {
    frozenAt: string;
    unpaidBalanceUsd: string;
    availableBalanceUsd: string;
    pendingRedemptionUsd: string;
    totalEarnedUsd: string;
    totalRedeemedUsd: string;
    bySource: {
      apps: string;
      agents: string;
      mcps: string;
      affiliates: string;
      revenueShares: string;
    };
    settledAt: string | null;
  } | null;
  affiliatePayableUsd: string;
  current: {
    availableBalanceUsd: string;
    pendingRedemptionUsd: string;
    totalEarnedUsd: string;
  };
}

function usd(value: string): string {
  return `$${Number(value).toFixed(2)}`;
}

function StatementRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <span className="text-sm text-muted">{label}</span>
      <span className="font-mono text-sm tabular-nums text-txt-strong">
        {value}
      </span>
    </div>
  );
}

export function CreatorEarningsStatementView({
  statement,
}: {
  statement: CreatorEarningsStatementDto;
}) {
  const t = useCloudT();
  const frozen = statement.frozen;
  return (
    <div
      className="flex flex-col gap-4"
      data-testid="creator-earnings-statement"
    >
      <Alert>
        <Info />
        <AlertDescription>
          {t("cloud.earningsStatement.retiredNotice", {
            defaultValue:
              "Creator earnings and payouts have been retired. Balances earned before retirement are frozen and will be settled by our team. Affiliate earnings since then are still paid out through Stripe Connect.",
          })}
        </AlertDescription>
      </Alert>

      <Card className="p-4">
        <h3 className="mb-2 text-base font-medium text-txt-strong">
          {t("cloud.earningsStatement.frozenTitle", {
            defaultValue: "Frozen balance",
          })}
        </h3>
        {frozen ? (
          <div>
            <StatementRow
              label={t("cloud.earningsStatement.unpaid", {
                defaultValue: "Unpaid balance",
              })}
              value={usd(frozen.unpaidBalanceUsd)}
            />
            <StatementRow
              label={t("cloud.earningsStatement.pending", {
                defaultValue: "Of which pending redemption",
              })}
              value={usd(frozen.pendingRedemptionUsd)}
            />
            <StatementRow
              label={t("cloud.earningsStatement.totalEarned", {
                defaultValue: "Lifetime earned",
              })}
              value={usd(frozen.totalEarnedUsd)}
            />
            <StatementRow
              label={t("cloud.earningsStatement.totalRedeemed", {
                defaultValue: "Already paid out",
              })}
              value={usd(frozen.totalRedeemedUsd)}
            />
            <StatementRow
              label={t("cloud.earningsStatement.fromApps", {
                defaultValue: "Earned from apps",
              })}
              value={usd(frozen.bySource.apps)}
            />
            <StatementRow
              label={t("cloud.earningsStatement.fromAgents", {
                defaultValue: "Earned from agents",
              })}
              value={usd(frozen.bySource.agents)}
            />
            <StatementRow
              label={t("cloud.earningsStatement.fromMcps", {
                defaultValue: "Earned from MCPs",
              })}
              value={usd(frozen.bySource.mcps)}
            />
            <StatementRow
              label={t("cloud.earningsStatement.fromAffiliates", {
                defaultValue: "Earned from affiliates",
              })}
              value={usd(frozen.bySource.affiliates)}
            />
            <StatementRow
              label={t("cloud.earningsStatement.fromRevenueShares", {
                defaultValue: "Earned from revenue shares",
              })}
              value={usd(frozen.bySource.revenueShares)}
            />
            <p className="mt-3 text-xs text-muted">
              {statement.status === "settled_manually" && frozen.settledAt
                ? t("cloud.earningsStatement.settledOn", {
                    date: new Date(frozen.settledAt).toLocaleDateString(),
                    defaultValue: "Settled on {{date}}.",
                  })
                : t("cloud.earningsStatement.frozenOn", {
                    date: new Date(frozen.frozenAt).toLocaleDateString(),
                    defaultValue: "Frozen on {{date}}.",
                  })}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted">
            {t("cloud.earningsStatement.none", {
              defaultValue: "You had no unpaid creator earnings at retirement.",
            })}
          </p>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="mb-2 text-base font-medium text-txt-strong">
          {t("cloud.earningsStatement.currentTitle", {
            defaultValue: "Current ledger balance",
          })}
        </h3>
        <StatementRow
          label={t("cloud.earningsStatement.currentAvailable", {
            defaultValue: "Available",
          })}
          value={usd(statement.current.availableBalanceUsd)}
        />
        <StatementRow
          label={t("cloud.earningsStatement.currentPending", {
            defaultValue: "Pending",
          })}
          value={usd(statement.current.pendingRedemptionUsd)}
        />
        <StatementRow
          label={t("cloud.earningsStatement.affiliatePayable", {
            defaultValue: "Affiliate earnings available for payout",
          })}
          value={usd(statement.affiliatePayableUsd)}
        />
      </Card>
    </div>
  );
}

/** Self-loading, auth-gated statement surface for the Monetization section. */
export function CreatorEarningsStatement() {
  const t = useCloudT();
  const { ready, authenticated } = useSessionAuth();
  const [statement, setStatement] =
    useState<CreatorEarningsStatementDto | null>(null);
  const [failed, setFailed] = useState(false);

  useDocumentTitle(
    t("cloud.earningsStatement.metaTitle", {
      defaultValue: "Creator earnings statement",
    }),
  );

  const load = useCallback(async () => {
    try {
      const response = await api<{ statement: CreatorEarningsStatementDto }>(
        "/api/v1/earnings/statement",
      );
      setStatement(response.statement);
      setFailed(false);
    } catch {
      // error-policy:J4 the statement is read-only; show an explicit error.
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (ready && authenticated) void load();
  }, [ready, authenticated, load]);

  if (failed) {
    return (
      <Alert variant="dashboardError">
        <AlertDescription>
          {t("cloud.earningsStatement.loadFailed", {
            defaultValue: "Could not load your earnings statement. Try again.",
          })}
        </AlertDescription>
      </Alert>
    );
  }
  if (!statement) {
    return (
      <DashboardLoadingState
        label={t("cloud.earningsStatement.loading", {
          defaultValue: "Loading earnings statement",
        })}
      />
    );
  }
  return <CreatorEarningsStatementView statement={statement} />;
}
