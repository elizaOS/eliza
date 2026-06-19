// Live Polymarket positions + PnL surface for the native AppView.
//
// Phase 2 of moving a waifu agent's surfaces into its own ElizaOS web UI: this
// is the prediction-market analogue of the sibling plugin-hyperliquid-app
// HyperliquidPositionsPanel. The existing PolymarketAppView fetches rich
// market data but never surfaced the agent's OWN positions — the `/positions`
// route returns market question, outcome (YES/NO), shares, current value, and
// cash/percent PnL, yet only a count ever reached the view (and only in the
// TUI). This panel renders that data: an account-health hero strip (portfolio
// value, total PnL, open count) over a dense per-position table (market /
// outcome / shares / value / unrealized PnL). Read-only — no trade execution
// lives here.
//
// Visual language matches PolymarketAppView exactly: that view styles with
// inline CSS-variable theme tokens (--accent, --txt, --muted, --border,
// --surface, --ok) rather than Tailwind utility classes, so this panel uses the
// same tokens to stay visually consistent with the surrounding markets list.
// The single non-neutral accents are profit-green and loss-red, mirroring the
// HL panel's one-green-one-red discipline.

import { TrendingDown, TrendingUp } from "lucide-react";
import type {
  PolymarketPosition,
  PolymarketPositionsSummary,
} from "./polymarket-contracts";

const ACCENT = "var(--accent, #ff8a24)";
const TXT = "var(--txt, #111)";
const MUTED = "var(--muted, rgba(0,0,0,0.58))";
const BORDER = "var(--border, rgba(0,0,0,0.12))";
const SURFACE = "var(--surface, rgba(0,0,0,0.04))";
const OK = "var(--ok, #22c55e)";
const DANGER = "var(--danger, #ef4444)";

const EMPTY_CELL = "—";

function parseNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatUsd(
  value: number | null,
  options: { withSign?: boolean } = {},
): string {
  if (value === null) return EMPTY_CELL;
  const sign = options.withSign && value > 0 ? "+" : value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function formatShares(value: string | null): string {
  const parsed = parseNumber(value);
  if (parsed === null) return EMPTY_CELL;
  return Math.abs(parsed).toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  });
}

function formatPercent(value: number | null): string {
  if (value === null) return EMPTY_CELL;
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function pnlColor(value: number | null): string {
  if (value === null || value === 0) return MUTED;
  return value > 0 ? OK : DANGER;
}

/**
 * The YES/NO (or named) outcome pill. Binary YES leans accent, NO leans muted;
 * any other outcome name renders neutral. Mirrors the OutcomeChip language in
 * PolymarketAppView without importing it (that one is market-list specific).
 */
function OutcomePill({ outcome }: { outcome: string | null }) {
  const label = outcome ?? "—";
  const normalized = label.trim().toLowerCase();
  const isYes = normalized === "yes";
  const isNo = normalized === "no";
  const color = isYes ? ACCENT : isNo ? MUTED : TXT;
  const background = isYes
    ? "var(--accent-subtle, rgba(255,138,36,0.14))"
    : SURFACE;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: 99,
        border: `1px solid ${isYes ? "var(--accent-subtle, rgba(255,138,36,0.3))" : BORDER}`,
        background,
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.02em",
        color,
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

function StatTile({
  label,
  value,
  color = TXT,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div
      style={{
        flex: "1 1 90px",
        minWidth: 90,
        borderRadius: 12,
        border: `1px solid ${BORDER}`,
        background: SURFACE,
        padding: "10px 12px",
      }}
    >
      <div style={{ fontSize: 11.5, color: MUTED }}>{label}</div>
      <div
        style={{
          marginTop: 4,
          fontSize: 16,
          fontWeight: 700,
          color,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function AccountHealthStrip({
  summary,
}: {
  summary: PolymarketPositionsSummary | null;
}) {
  const totalValue = parseNumber(summary?.totalValue ?? null);
  const totalPnl = parseNumber(summary?.totalCashPnl ?? null);
  const totalPercent = parseNumber(summary?.totalPercentPnl ?? null);
  const openPositions = summary?.openPositions ?? 0;

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <StatTile label="Portfolio" value={formatUsd(totalValue)} />
      <StatTile
        label="Total PnL"
        value={formatUsd(totalPnl, { withSign: true })}
        color={pnlColor(totalPnl)}
      />
      <StatTile
        label="Return"
        value={formatPercent(totalPercent)}
        color={pnlColor(totalPercent)}
      />
      <StatTile label="Open" value={String(openPositions)} />
    </div>
  );
}

function PositionRow({ position }: { position: PolymarketPosition }) {
  const label = position.question ?? position.slug ?? position.marketId ?? "—";
  const value = parseNumber(position.currentValue);
  const cashPnl = parseNumber(position.cashPnl);
  const percentPnl = parseNumber(position.percentPnl);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns:
          "minmax(0, 1.6fr) minmax(0, 0.8fr) minmax(0, 0.8fr) minmax(0, 1fr)",
        gap: 10,
        alignItems: "center",
        padding: "11px 14px",
        borderTop: `1px solid ${BORDER}`,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 5,
          minWidth: 0,
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: TXT,
            lineHeight: 1.3,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {label}
        </span>
        <OutcomePill outcome={position.outcome} />
      </div>

      <span
        style={{
          textAlign: "right",
          fontSize: 12.5,
          color: MUTED,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatShares(position.size)}
      </span>

      <span
        style={{
          textAlign: "right",
          fontSize: 12.5,
          color: TXT,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatUsd(value)}
      </span>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          lineHeight: 1.25,
        }}
      >
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 700,
            color: pnlColor(cashPnl),
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {formatUsd(cashPnl, { withSign: true })}
        </span>
        {percentPnl !== null ? (
          <span
            style={{
              fontSize: 11,
              color: pnlColor(percentPnl),
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {formatPercent(percentPnl)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function HeaderRow() {
  const cellStyle: React.CSSProperties = {
    fontSize: 10.5,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: MUTED,
  };
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns:
          "minmax(0, 1.6fr) minmax(0, 0.8fr) minmax(0, 0.8fr) minmax(0, 1fr)",
        gap: 10,
        padding: "9px 14px",
        borderBottom: `1px solid ${BORDER}`,
      }}
    >
      <span style={cellStyle}>Market / Outcome</span>
      <span style={{ ...cellStyle, textAlign: "right" }}>Shares</span>
      <span style={{ ...cellStyle, textAlign: "right" }}>Value</span>
      <span style={{ ...cellStyle, textAlign: "right" }}>PnL</span>
    </div>
  );
}

export interface PolymarketPositionsPanelProps {
  positions: readonly PolymarketPosition[];
  summary: PolymarketPositionsSummary | null;
  /** Account-read blocked reason (e.g. no wallet configured). Null when ready. */
  blockedReason?: string | null;
}

/**
 * The live positions + PnL surface. Renders the account-health hero strip and a
 * dense per-position table, or an honest empty/blocked state. Display only.
 */
export function PolymarketPositionsPanel({
  positions,
  summary,
  blockedReason = null,
}: PolymarketPositionsPanelProps) {
  // Show only positions that still hold shares — closed/dust rows are noise.
  const openPositions = positions.filter((position) => {
    const size = parseNumber(position.size);
    return size !== null && Math.abs(size) > 1e-9;
  });
  const totalPnl = parseNumber(summary?.totalCashPnl ?? null);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <AccountHealthStrip summary={summary} />

      <div
        style={{
          borderRadius: 16,
          border: `1px solid ${BORDER}`,
          background: "var(--card, #fff)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "11px 14px",
            borderBottom:
              blockedReason || openPositions.length === 0
                ? "none"
                : `1px solid ${BORDER}`,
          }}
        >
          {totalPnl !== null && totalPnl < 0 ? (
            <TrendingDown style={{ width: 16, height: 16, color: DANGER }} />
          ) : (
            <TrendingUp style={{ width: 16, height: 16, color: MUTED }} />
          )}
          <span style={{ fontSize: 13, fontWeight: 600, color: TXT }}>
            Positions
          </span>
          <span style={{ fontSize: 12, color: MUTED }}>
            {openPositions.length}
          </span>
        </div>

        {blockedReason ? (
          <div
            style={{
              padding: "22px 16px",
              textAlign: "center",
              fontSize: 12.5,
              color: MUTED,
            }}
          >
            {blockedReason}
          </div>
        ) : openPositions.length === 0 ? (
          <div
            style={{
              padding: "26px 16px",
              textAlign: "center",
              fontSize: 12.5,
              color: MUTED,
            }}
          >
            No open positions
          </div>
        ) : (
          <>
            <HeaderRow />
            {openPositions.map((position) => (
              <PositionRow
                key={`${position.conditionId ?? position.marketId ?? position.slug}-${position.outcome}`}
                position={position}
              />
            ))}
          </>
        )}
      </div>
    </section>
  );
}
