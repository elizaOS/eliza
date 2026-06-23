import {
	Button,
	type OverlayAppContext,
} from "@elizaos/app-core/ui-compat";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { ArrowLeft } from "lucide-react";
import { useEffect } from "react";
import { PolymarketPositionsPanel } from "./PolymarketPositionsPanel";
import type {
  PolymarketMarket,
  PolymarketStatusResponse,
} from "./polymarket-contracts";
import { usePolymarketState } from "./usePolymarketState";

const ACCENT = "var(--accent, #ff8a24)";
const ACCENT_LIGHT = "#ffb066";
const ACCENT_SUBTLE = "var(--accent-subtle, rgba(255,138,36,0.12))";
const TXT = "var(--txt, #111)";
const MUTED = "var(--muted, rgba(0,0,0,0.58))";
const BORDER = "var(--border, rgba(0,0,0,0.12))";
const SURFACE = "var(--surface, rgba(0,0,0,0.04))";

function priceToPercent(price: string | null): number | null {
  if (price == null) return null;
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function shortNumber(value: string | null): string | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function PolymarketAppView({ exitToApps, t }: OverlayAppContext) {
  const {
    status,
    markets,
    selectedMarket,
    setSelectedMarket,
    positions,
    loading,
    error,
    refresh,
  } = usePolymarketState();

  const selectedMarketId = selectedMarket?.id;

  // The view has no live subscription, so keep the market list fresh with a
  // quiet background poll instead of a manual Refresh button.
  useEffect(() => {
    const interval = setInterval(() => {
      void refresh();
    }, 20000);
    return () => clearInterval(interval);
  }, [refresh]);

  const backLabel = t("nav.back", { defaultValue: "Back" });
  const back = useAgentElement<HTMLButtonElement>({
    id: "action-back",
    role: "button",
    label: backLabel,
    group: "polymarket-nav",
    description: "Exit Polymarket and return to the apps list",
  });

  const showEmpty = !loading && markets.length === 0;

  return (
    <div
      data-testid="polymarket-shell"
      className="fixed inset-0 z-50 flex h-[100vh] flex-col overflow-hidden bg-bg supports-[height:100dvh]:h-[100dvh]"
    >
      <style>
        {
          "@keyframes pmShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}"
        }
      </style>
      <div className="flex shrink-0 items-center justify-between border-b border-border/20 bg-bg/80 px-4 py-3 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            ref={back.ref}
            {...back.agentProps}
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 rounded-xl text-muted hover:text-txt"
            onClick={exitToApps}
            aria-label={backLabel}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div
            className="min-w-0"
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <PolymarketGlyph size={22} />
            <h1 className="truncate text-base font-semibold text-txt">
              Polymarket
            </h1>
          </div>
        </div>
      </div>

      <div className="chat-native-scrollbar flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {selectedMarket ? (
            <MarketDetail
              market={selectedMarket}
              onBack={() => setSelectedMarket(null)}
            />
          ) : showEmpty ? (
            <DisconnectedState status={status} error={error} />
          ) : (
            <section
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
              <ReadinessStrip status={status} />
              {status?.account?.ready ? (
                <PolymarketPositionsPanel
                  positions={positions?.positions ?? []}
                  summary={positions?.summary ?? null}
                  blockedReason={status.account?.reason ?? null}
                />
              ) : null}
              {loading && markets.length === 0 ? (
                <div style={{ display: "grid", gap: 10 }}>
                  {[0, 1, 2, 3].map((i) => (
                    <MarketSkeleton key={i} />
                  ))}
                </div>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {markets.slice(0, 24).map((market) => (
                    <MarketCard
                      key={market.id}
                      market={market}
                      active={selectedMarketId === market.id}
                      onSelect={setSelectedMarket}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function PolymarketGlyph({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <title>Polymarket</title>
      <defs>
        <linearGradient id="pmYes" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={ACCENT} />
          <stop offset="100%" stopColor={ACCENT_LIGHT} />
        </linearGradient>
      </defs>
      <circle
        cx="16"
        cy="16"
        r="15"
        fill="none"
        stroke={BORDER}
        strokeWidth="2"
      />
      <path
        d="M16 1 A15 15 0 0 1 31 16 L16 16 Z"
        fill="url(#pmYes)"
        opacity="0.85"
      />
      <circle cx="16" cy="16" r="6" fill="var(--bg, #fff)" />
      <circle cx="16" cy="16" r="2.5" fill={ACCENT} />
    </svg>
  );
}

function StateDot({ ready }: { ready: boolean }) {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: 99,
        background: ready ? ACCENT : MUTED,
        boxShadow: ready ? `0 0 0 3px ${ACCENT_SUBTLE}` : "none",
        flexShrink: 0,
      }}
    />
  );
}

function CapabilityChip({
  label,
  ready,
  hint,
}: {
  label: string;
  ready: boolean;
  hint: string;
}) {
  return (
    <div
      title={hint}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "7px 12px",
        borderRadius: 99,
        border: `1px solid ${BORDER}`,
        background: SURFACE,
        fontSize: 13,
        fontWeight: 600,
        color: TXT,
      }}
    >
      <StateDot ready={ready} />
      {label}
      <span style={{ color: MUTED, fontWeight: 500, fontSize: 12 }}>
        {ready ? "on" : "off"}
      </span>
    </div>
  );
}

function ReadinessStrip({
  status,
}: {
  status: PolymarketStatusResponse | null;
}) {
  const reads = status?.publicReads.ready ?? false;
  const trading = status?.trading.ready ?? false;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        alignItems: "center",
      }}
    >
      <CapabilityChip
        label="Read-only"
        ready={reads}
        hint="Public market data (no credentials needed)"
      />
      <CapabilityChip
        label="Trading"
        ready={trading}
        hint={status?.trading.reason ?? "Signed order placement"}
      />
    </div>
  );
}

function DisconnectedState({
  status,
  error,
}: {
  status: PolymarketStatusResponse | null;
  error: string | null;
}) {
  const reads = status?.publicReads.ready ?? false;
  const trading = status?.trading.ready ?? false;
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        gap: 16,
        padding: "48px 20px",
        margin: "auto 0",
      }}
    >
      <div
        style={{
          position: "relative",
          width: 96,
          height: 96,
          borderRadius: 28,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--accent-subtle, rgba(255,138,36,0.14))",
          border: `1px solid ${BORDER}`,
        }}
      >
        <PolymarketGlyph size={52} />
      </div>
      <div style={{ maxWidth: 360 }}>
        <h2
          style={{
            margin: 0,
            fontSize: 19,
            fontWeight: 700,
            color: TXT,
          }}
        >
          {error ? "Markets unavailable" : "No markets loaded"}
        </h2>
        {error ? (
          <p
            style={{
              margin: "8px 0 0",
              fontSize: 14,
              color: MUTED,
              lineHeight: 1.5,
            }}
          >
            Couldn't reach Polymarket right now. Try again in a moment.
          </p>
        ) : null}
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          justifyContent: "center",
        }}
      >
        <CapabilityChip
          label="Read-only"
          ready={reads}
          hint="Public market data (no credentials needed)"
        />
        <CapabilityChip
          label="Trading"
          ready={trading}
          hint={status?.trading.reason ?? "Signed order placement"}
        />
      </div>
      {!trading && status?.trading.missing.length ? (
        <p
          style={{
            margin: 0,
            fontSize: 12,
            color: MUTED,
            maxWidth: 360,
          }}
        >
          To enable trading, configure{" "}
          <code style={{ fontSize: 11, color: MUTED }}>
            {status.trading.missing.join(", ")}
          </code>{" "}
          in Settings.
        </p>
      ) : null}
    </section>
  );
}

function MarketSkeleton() {
  return (
    <div
      style={{
        height: 86,
        borderRadius: 16,
        border: `1px solid ${BORDER}`,
        background: `linear-gradient(90deg, ${SURFACE} 0%, var(--bg-hover, rgba(0,0,0,0.06)) 50%, ${SURFACE} 100%)`,
        backgroundSize: "200% 100%",
        animation: "pmShimmer 1.4s ease-in-out infinite",
      }}
    />
  );
}

function OutcomeChip({
  name,
  percent,
  rank,
}: {
  name: string;
  percent: number | null;
  rank: number;
}) {
  const lead = rank === 0;
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 10px",
        borderRadius: 99,
        border: `1px solid ${lead ? "var(--accent-subtle, rgba(255,138,36,0.3))" : BORDER}`,
        background: lead
          ? "var(--accent-subtle, rgba(255,138,36,0.14))"
          : SURFACE,
        fontSize: 12.5,
        fontWeight: 600,
        color: TXT,
        maxWidth: "100%",
      }}
    >
      <span
        style={{
          maxWidth: 130,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
      {percent != null ? (
        <span
          style={{
            color: lead ? ACCENT : MUTED,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {percent}%
        </span>
      ) : null}
    </div>
  );
}

function MarketCard({
  market,
  active,
  onSelect,
}: {
  market: PolymarketMarket;
  active: boolean;
  onSelect: (market: PolymarketMarket) => void;
}) {
  const label = market.question ?? market.slug ?? market.id;
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `market-${market.id}`,
    role: "list-item",
    label,
    group: "polymarket-markets",
    status: active ? "active" : "inactive",
    description: `Select the ${label} market`,
  });
  const volume = shortNumber(market.volume24hr ?? market.volume);
  const liquidity = shortNumber(market.liquidity);
  const outcomes = market.outcomes.slice(0, 3);
  return (
    <button
      ref={ref}
      {...agentProps}
      type="button"
      onClick={() => onSelect(market)}
      aria-current={active ? "true" : undefined}
      style={{
        display: "flex",
        gap: 12,
        width: "100%",
        textAlign: "left",
        padding: 14,
        borderRadius: 16,
        border: `1px solid ${active ? ACCENT : BORDER}`,
        background: active
          ? "var(--accent-subtle, rgba(255,138,36,0.08))"
          : "var(--card, #fff)",
        cursor: "pointer",
        font: "inherit",
        color: TXT,
        alignItems: "flex-start",
      }}
    >
      <span
        style={{
          width: 40,
          height: 40,
          borderRadius: 12,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: SURFACE,
          border: `1px solid ${BORDER}`,
          overflow: "hidden",
        }}
      >
        {market.icon || market.image ? (
          <img
            src={market.icon ?? market.image ?? ""}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <PolymarketGlyph size={24} />
        )}
      </span>
      <span
        style={{
          minWidth: 0,
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            lineHeight: 1.35,
            color: TXT,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {label}
        </span>
        <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {outcomes.map((outcome, i) => (
            <OutcomeChip
              key={outcome.name}
              name={outcome.name}
              percent={priceToPercent(outcome.price)}
              rank={i}
            />
          ))}
        </span>
        <span style={{ display: "flex", gap: 14, fontSize: 12, color: MUTED }}>
          {volume ? <span>Vol {volume}</span> : null}
          {liquidity ? <span>Liq {liquidity}</span> : null}
          {market.category ? <span>{market.category}</span> : null}
        </span>
      </span>
    </button>
  );
}

function MarketDetail({
  market,
  onBack,
}: {
  market: PolymarketMarket;
  onBack: () => void;
}) {
  return (
    <section style={{ minWidth: 0 }}>
      <button
        type="button"
        onClick={onBack}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 16,
          background: "transparent",
          border: "none",
          font: "inherit",
          fontSize: 12.5,
          fontWeight: 600,
          color: MUTED,
          cursor: "pointer",
        }}
      >
        <ArrowLeft style={{ width: 14, height: 14 }} />
        Markets
      </button>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <span
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: SURFACE,
            border: `1px solid ${BORDER}`,
            overflow: "hidden",
          }}
        >
          {market.icon || market.image ? (
            <img
              src={market.icon ?? market.image ?? ""}
              alt=""
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <PolymarketGlyph size={26} />
          )}
        </span>
        <h2
          style={{
            margin: 0,
            fontSize: 19,
            fontWeight: 700,
            lineHeight: 1.3,
            color: TXT,
          }}
        >
          {market.question ?? market.slug}
        </h2>
      </div>

      <div
        style={{ display: "flex", gap: 24, marginTop: 18, flexWrap: "wrap" }}
      >
        <Metric label="Volume" value={shortNumber(market.volume) ?? "—"} />
        <Metric
          label="Liquidity"
          value={shortNumber(market.liquidity) ?? "—"}
        />
        <Metric
          label="Last trade"
          value={
            priceToPercent(market.lastTradePrice) != null
              ? `${priceToPercent(market.lastTradePrice)}%`
              : "—"
          }
        />
      </div>

      <div style={{ marginTop: 24 }}>
        <div
          style={{
            paddingBottom: 4,
            fontSize: 12,
            fontWeight: 600,
            color: MUTED,
          }}
        >
          Outcomes
        </div>
        {market.outcomes.map((outcome, i) => {
          const pct = priceToPercent(outcome.price);
          return (
            <div
              key={outcome.name}
              style={{
                padding: "11px 0",
                borderTop: `1px solid ${BORDER}`,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  fontSize: 13.5,
                }}
              >
                <span style={{ fontWeight: 600, color: TXT }}>
                  {outcome.name}
                </span>
                <span
                  style={{ fontWeight: 700, color: i === 0 ? ACCENT : MUTED }}
                >
                  {pct != null ? `${pct}%` : "n/a"}
                </span>
              </div>
              {pct != null ? (
                <div
                  style={{
                    height: 6,
                    borderRadius: 99,
                    background: SURFACE,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: "100%",
                      borderRadius: 99,
                      background: i === 0 ? ACCENT : MUTED,
                    }}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ flex: "1 1 90px", minWidth: 90 }}>
      <div style={{ fontSize: 11.5, color: MUTED }}>{label}</div>
      <div
        style={{
          marginTop: 4,
          fontSize: 15,
          fontWeight: 700,
          color: TXT,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
    </div>
  );
}
