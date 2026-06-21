// Live Hyperliquid positions + PnL surface for the native AppView.
//
// Phase 2 of moving a waifu agent's surfaces into its own ElizaOS web UI: this
// replaces the broken waifu patron panels (active-positions.tsx + pnl-chart.tsx)
// with a native ElizaOS view that reads the same data shape from the plugin's
// `/api/hyperliquid/positions` route (which resolves the agent's HL address from
// its managed vault / env account).
//
// It mirrors the waifu "account health" UX: a four-stat hero strip (account
// value, effective leverage, withdrawable, unrealized pnl) over a dense
// position table (asset/side, size, notional, entry, mark, per-position
// leverage badge, distance-to-liquidation as a percent, unrealized pnl in
// green/red). Read-only — no trade execution lives here.
//
// Visual language matches HyperliquidAppView exactly: app-core `PagePanel`
// primitives are not needed for the table rows (static display), so we use the
// same Tailwind theme tokens the AppView already uses (`text-txt`, `text-muted`,
// `border-border`, `bg-card`, `text-ok`, `text-danger`). The single non-neutral
// accents are `text-ok` (profit) and `text-danger` (loss), matching the waifu
// panel's discipline of one green + one red and nothing else.

import {
  BarChart3,
  ShieldCheck,
  ShieldX,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import type {
  HyperliquidAccountSummary,
  HyperliquidPosition,
} from "./hyperliquid-contracts";

const EMPTY_CELL = "·";

function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatUsd(
  value: number | null,
  options: { withSign?: boolean; decimals?: number } = {},
): string {
  if (value === null || !Number.isFinite(value)) return EMPTY_CELL;
  const decimals = options.decimals ?? 2;
  const sign = options.withSign && value > 0 ? "+" : value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const body =
    abs >= 1000
      ? abs.toLocaleString("en-US", {
          maximumFractionDigits: decimals,
          minimumFractionDigits: decimals,
        })
      : abs.toFixed(decimals);
  return `${sign}$${body}`;
}

function formatUsdCompact(
  value: number | null,
  options: { withSign?: boolean } = {},
): string {
  if (value === null || !Number.isFinite(value)) return EMPTY_CELL;
  const sign = options.withSign && value > 0 ? "+" : value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}m`;
  if (abs >= 1_000)
    return `${sign}$${(abs / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}k`;
  return `${sign}$${abs.toFixed(2)}`;
}

function formatPrice(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return EMPTY_CELL;
  const abs = Math.abs(value);
  const decimals = abs >= 1000 ? 1 : abs >= 1 ? 2 : 5;
  return value.toLocaleString("en-US", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  });
}

function formatSize(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return Math.abs(parsed).toLocaleString("en-US", {
    maximumFractionDigits: 4,
    minimumFractionDigits: 0,
  });
}

function pnlTone(value: number | null): string {
  if (value === null || value === 0) return "text-muted";
  return value > 0 ? "text-ok" : "text-danger";
}

// Effective leverage and distance-to-liquidation are computed server-side and
// arrive as DTO fields (summary.effectiveLeverage, position.distanceToLiquidationPct);
// the panel only displays them — no financial math lives here.

// Mirrors HyperliquidAppView's ReadinessPill so the "Blocked"/readable status
// language stays identical across the view.
function ReadinessPill({ ready, label }: { ready: boolean; label: string }) {
  return (
    <span
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border ${
        ready
          ? "border-ok/35 bg-ok/12 text-ok"
          : "border-border bg-bg-accent text-muted"
      }`}
      role="status"
      aria-label={label}
      title={label}
    >
      {ready ? (
        <ShieldCheck className="h-4 w-4" />
      ) : (
        <ShieldX className="h-4 w-4" />
      )}
    </span>
  );
}

function StatTile({
  label,
  value,
  tone = "text-txt",
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/24 bg-card/50 px-3 py-2.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
      <span className={`font-mono text-lg font-semibold tabular-nums ${tone}`}>
        {value}
      </span>
    </div>
  );
}

function AccountHealthStrip({
  summary,
}: {
  summary: HyperliquidAccountSummary | null;
}) {
  const accountValue = toNumber(summary?.accountValue ?? null);
  const withdrawable = toNumber(summary?.withdrawable ?? null);
  const unrealizedPnl = toNumber(summary?.totalUnrealizedPnl ?? null);
  const leverage = summary?.effectiveLeverage ?? null;

  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatTile label="Account value" value={formatUsdCompact(accountValue)} />
      <StatTile
        label="Effective lev"
        value={leverage === null ? EMPTY_CELL : `${leverage.toFixed(2)}x`}
      />
      <StatTile label="Withdrawable" value={formatUsdCompact(withdrawable)} />
      <StatTile
        label="Unrealized PnL"
        value={formatUsdCompact(unrealizedPnl, { withSign: true })}
        tone={pnlTone(unrealizedPnl)}
      />
    </section>
  );
}

function PositionRow({ position }: { position: HyperliquidPosition }) {
  const size = Number(position.size);
  const isLong = Number.isFinite(size) ? size >= 0 : true;
  const unrealizedPnl = toNumber(position.unrealizedPnl);
  const roe = toNumber(position.returnOnEquity);
  // Normalize undefined → null so the `=== null` guard below catches a missing
  // DTO field; otherwise `undefined.toFixed()` crashes the whole view (#8796).
  const liqDistance = position.distanceToLiquidationPct ?? null;

  return (
    <div className="grid grid-cols-[minmax(0,1.2fr)_repeat(4,minmax(0,1fr))] items-center gap-3 px-4 py-2.5 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-semibold text-txt">
          {position.coin}
        </span>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
            isLong ? "bg-ok/12 text-ok" : "bg-danger/12 text-danger"
          }`}
        >
          {isLong ? "long" : "short"}
        </span>
        {position.leverageValue !== null && (
          <span className="rounded bg-bg-accent px-1.5 py-0.5 font-mono text-[10px] text-muted">
            {position.leverageValue}x
          </span>
        )}
      </div>

      <span className="text-right font-mono text-xs tabular-nums text-muted">
        {formatSize(position.size)}
      </span>

      <span className="text-right font-mono text-xs tabular-nums text-muted">
        {formatUsd(toNumber(position.positionValue))}
      </span>

      <div className="flex flex-col items-end leading-tight">
        <span className="font-mono text-xs tabular-nums text-txt">
          {formatPrice(toNumber(position.entryPx))}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-muted">
          {liqDistance === null
            ? EMPTY_CELL
            : `${liqDistance.toFixed(0)}% to liq`}
        </span>
      </div>

      <div className="flex flex-col items-end leading-tight">
        <span
          className={`font-mono text-xs font-semibold tabular-nums ${pnlTone(unrealizedPnl)}`}
        >
          {formatUsd(unrealizedPnl, { withSign: true })}
        </span>
        {roe !== null && (
          <span
            className={`font-mono text-[10px] tabular-nums ${pnlTone(roe)}`}
          >
            {`${roe > 0 ? "+" : ""}${(roe * 100).toFixed(1)}%`}
          </span>
        )}
      </div>
    </div>
  );
}

export interface HyperliquidPositionsPanelProps {
  positions: HyperliquidPosition[];
  summary: HyperliquidAccountSummary | null;
  readBlockedReason: string | null;
}

/**
 * The live positions + PnL surface. Renders the account-health hero strip and a
 * dense per-position table, or an honest empty/blocked state. Display only.
 */
export function HyperliquidPositionsPanel({
  positions,
  summary,
  readBlockedReason,
}: HyperliquidPositionsPanelProps) {
  const openPositions = positions.filter((position) => {
    const size = Number(position.size);
    return Number.isFinite(size) && size !== 0;
  });
  const totalPnl = toNumber(summary?.totalUnrealizedPnl ?? null);

  return (
    <section className="space-y-3">
      <AccountHealthStrip summary={summary} />

      <div className="rounded-lg border border-border/24 bg-card/50">
        <div className="flex items-center gap-2 border-b border-border/20 px-4 py-3">
          {totalPnl !== null && totalPnl < 0 ? (
            <TrendingDown className="h-4 w-4 text-danger" />
          ) : (
            <TrendingUp className="h-4 w-4 text-muted" />
          )}
          <h2 className="text-sm font-semibold text-txt">Positions</h2>
          <span className="text-xs text-muted">{openPositions.length}</span>
          <div className="ml-auto">
            <ReadinessPill
              ready={!readBlockedReason}
              label={readBlockedReason ? "Blocked" : "Positions readable"}
            />
          </div>
        </div>

        {readBlockedReason ? (
          <div className="px-4 py-6 text-center text-xs text-muted">
            {readBlockedReason}
          </div>
        ) : openPositions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <BarChart3 className="h-5 w-5 text-muted" />
            <span className="text-xs text-muted">no open positions</span>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[minmax(0,1.2fr)_repeat(4,minmax(0,1fr))] gap-3 border-b border-border/14 px-4 py-2 text-[10px] font-medium uppercase tracking-wide text-muted">
              <span>Asset</span>
              <span className="text-right">Size</span>
              <span className="text-right">Notional</span>
              <span className="text-right">Entry</span>
              <span className="text-right">uPnL</span>
            </div>
            <div className="divide-y divide-border/14">
              {openPositions.map((position) => (
                <PositionRow key={position.coin} position={position} />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
