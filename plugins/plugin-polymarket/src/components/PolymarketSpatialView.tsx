/**
 * Polymarket market presentation built from spatial primitives for the shipped
 * GUI view. It consumes a resolved snapshot plus an action callback; status,
 * market, and position polling stay in PolymarketView.
 */

import {
  Button,
  Card,
  HStack,
  isEvaluatingToIR,
  List,
  type SpatialTone,
  Text,
  VStack,
} from "@elizaos/ui/spatial";
import type {
  PolymarketMarket,
  PolymarketPosition,
  PolymarketPositionsSummary,
  PolymarketStatusResponse,
} from "../polymarket-contracts";

export interface PolymarketSnapshot {
  status: PolymarketStatusResponse | null;
  markets: readonly PolymarketMarket[];
  /** Detail overlay target; null shows the list. */
  selectedMarket: PolymarketMarket | null;
  /** The agent's own open positions; empty when none/unreadable. */
  positions?: readonly PolymarketPosition[];
  /** Aggregate value/PnL across `positions`; null when none. */
  positionsSummary?: PolymarketPositionsSummary | null;
  loading?: boolean;
  error?: string | null;
  lastAction?: string;
}

const MAX_LIST = 10;
const MAX_OUTCOMES = 2;
const MAX_POSITION_ROWS = 3;

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

function marketLabel(market: PolymarketMarket): string {
  return market.question ?? market.slug ?? market.id;
}

function parseNumber(value: string | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function usd(value: number | null, withSign = false): string {
  if (value == null) return "-";
  const sign = withSign && value > 0 ? "+" : value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function pnlTone(value: number | null): SpatialTone {
  if (value == null || value === 0) return "muted";
  return value > 0 ? "success" : "danger";
}

function readyTone(ready: boolean): SpatialTone {
  return ready ? "success" : "muted";
}

function ReadinessRow({ status }: { status: PolymarketStatusResponse | null }) {
  // `publicReads`/`trading` are typed as required but a partial status response
  // can omit them (#14448); fully optional-chain so a missing block reads as
  // "off" rather than throwing a raw property-read into the view.
  const reads = status?.publicReads?.ready ?? false;
  const trading = status?.trading?.ready ?? false;
  return (
    <HStack gap={2} align="center" wrap>
      <Text style="caption" tone={readyTone(reads)}>
        {`reads ${reads ? "ready" : "off"}`}
      </Text>
      <Text style="caption" tone={readyTone(trading)}>
        {`trading ${trading ? "ready" : "off"}`}
      </Text>
    </HStack>
  );
}

function outcomeSummary(outcome: PolymarketMarket["outcomes"][number]): string {
  const percent = priceToPercent(outcome.price);
  return `${outcome.name} ${percent != null ? `${percent}%` : "n/a"}`;
}

function compactOutcomeSummary(market: PolymarketMarket): string | null {
  if (market.outcomes.length > 0) {
    return market.outcomes.map(outcomeSummary).join(" · ");
  }
  const lastTrade = priceToPercent(market.lastTradePrice);
  if (lastTrade == null) return null;
  if (market.clobTokenIds.length === 2) {
    return `Yes ${lastTrade}% · No ${100 - lastTrade}%`;
  }
  return `Last trade ${lastTrade}%`;
}

function MarketRow({
  market,
  index,
  active,
  onAction,
}: {
  market: PolymarketMarket;
  index: number;
  active: boolean;
  onAction?: (action: string) => void;
}) {
  const label = marketLabel(market);
  const volume = shortNumber(market.volume24hr ?? market.volume);
  const liquidity = shortNumber(market.liquidity);
  const top = market.outcomes.slice(0, MAX_OUTCOMES);
  return (
    <VStack
      gap={0}
      grow={1}
      agent={`market-${market.id}`}
      tone={active ? "primary" : "default"}
    >
      <HStack gap={1} align="center">
        <Text tone={active ? "primary" : "muted"} width={3}>
          {String(index + 1).padStart(2, "0")}
        </Text>
        <Text bold grow={1} wrap={false}>
          {label}
        </Text>
        <Text style="caption" tone={market.active ? "success" : "muted"}>
          {market.active ? "active" : "closed"}
        </Text>
        <Button
          variant="ghost"
          tone="primary"
          agent={`market:${market.id}`}
          onPress={() => onAction?.(`market:${market.id}`)}
        >
          Open
        </Button>
      </HStack>
      {top.length > 0 ? (
        <HStack gap={2} wrap>
          {top.map((outcome) => (
            <Text key={outcome.name} style="caption" tone="muted" wrap={false}>
              {outcomeSummary(outcome)}
            </Text>
          ))}
        </HStack>
      ) : null}
      <HStack gap={2} wrap>
        {volume ? (
          <Text style="caption" tone="muted">{`vol ${volume}`}</Text>
        ) : null}
        {liquidity ? (
          <Text style="caption" tone="muted">{`liq ${liquidity}`}</Text>
        ) : null}
        {market.category ? (
          <Text style="caption" tone="muted" wrap={false}>
            {market.category}
          </Text>
        ) : null}
      </HStack>
    </VStack>
  );
}

function MarketDetail({
  market,
  onAction,
  compact = false,
}: {
  market: PolymarketMarket;
  onAction?: (action: string) => void;
  compact?: boolean;
}) {
  if (compact) {
    const lastTrade = priceToPercent(market.lastTradePrice);
    const compactMetrics = [
      `Vol ${shortNumber(market.volume) ?? "-"}`,
      `Liq ${shortNumber(market.liquidity) ?? "-"}`,
      `Last ${lastTrade != null ? `${lastTrade}%` : "-"}`,
    ].join(" · ");
    const compactOutcomes = compactOutcomeSummary(market);
    return (
      <VStack gap={1}>
        <Text style="subheading" wrap>
          {market.question ?? market.slug ?? market.id}
        </Text>
        {compactOutcomes ? (
          <Text tone="primary" wrap>
            {compactOutcomes}
          </Text>
        ) : null}
        <Text style="caption" tone="muted" wrap>
          {compactMetrics}
        </Text>
      </VStack>
    );
  }

  const top = market.outcomes.slice(0, MAX_OUTCOMES);
  return (
    <VStack gap={1}>
      <Button
        variant="ghost"
        tone="default"
        agent="detail-back"
        onPress={() => onAction?.("detail-back")}
      >
        {"< Markets"}
      </Button>
      <Text style="subheading" wrap>
        {market.question ?? market.slug ?? market.id}
      </Text>
      {top.length > 0 ? (
        <HStack gap={2} align="center" wrap>
          {top.map((outcome, i) => (
            <Text
              key={outcome.name}
              style="caption"
              tone={i === 0 ? "primary" : "muted"}
              wrap={false}
            >
              {outcomeSummary(outcome)}
            </Text>
          ))}
        </HStack>
      ) : null}
    </VStack>
  );
}

function PositionRow({ position }: { position: PolymarketPosition }) {
  const label =
    position.question ?? position.slug ?? position.marketId ?? position.outcome;
  const value = parseNumber(position.currentValue);
  const cashPnl = parseNumber(position.cashPnl);
  return (
    <HStack gap={1} align="center">
      <Text grow={1} wrap={false}>
        {label ?? "-"}
      </Text>
      {position.outcome ? (
        <Text style="caption" tone="muted" wrap={false}>
          {position.outcome}
        </Text>
      ) : null}
      <Text style="caption" tone="muted" align="end" width={8}>
        {usd(value)}
      </Text>
      <Text style="caption" tone={pnlTone(cashPnl)} align="end" width={8}>
        {usd(cashPnl, true)}
      </Text>
    </HStack>
  );
}

function MarketsEmptyState({
  loading,
  error,
}: {
  loading: boolean;
  error: string | null;
}) {
  // Three distinguishable no-data renders (#15781): a failed load is a
  // danger-toned error block, an in-flight load a neutral "loading" line, and a
  // resolved-but-empty response a muted "empty" line. `refresh` clears `error`
  // before it sets `loading`, so the two are mutually exclusive and the error
  // branch can take precedence without masking an in-flight retry.
  if (error) {
    return (
      <VStack gap={0} align="center" tone="danger" border padding={1}>
        <Text tone="danger" style="caption" bold>
          Couldn't load markets
        </Text>
        <Text tone="danger" style="caption" align="center" wrap>
          {error}
        </Text>
      </VStack>
    );
  }
  return (
    <Text tone="muted" align="center" style="caption">
      {loading ? "loading markets" : "no markets loaded"}
    </Text>
  );
}

function PositionsSection({
  positions,
  summary,
}: {
  positions: readonly PolymarketPosition[];
  summary: PolymarketPositionsSummary | null;
}) {
  const open = positions.filter((position) => {
    const size = parseNumber(position.size);
    return size != null && Math.abs(size) > 1e-9;
  });
  const totalValue = parseNumber(summary?.totalValue ?? null);
  const totalPnl = parseNumber(summary?.totalCashPnl ?? null);
  return (
    <>
      <Text style="caption" tone="muted">
        positions
      </Text>
      <HStack gap={2} wrap>
        <Text style="caption" tone="muted">{`value ${usd(totalValue)}`}</Text>
        <Text style="caption" tone={pnlTone(totalPnl)}>
          {`pnl ${usd(totalPnl, true)}`}
        </Text>
        <Text style="caption" tone="muted">{`open ${open.length}`}</Text>
      </HStack>
      {open.length === 0 ? (
        <Text style="caption" tone="muted" align="center">
          no open positions
        </Text>
      ) : (
        <List gap={0}>
          {open.slice(0, MAX_POSITION_ROWS).map((position) => (
            <PositionRow
              key={`${position.conditionId ?? position.marketId ?? position.slug}-${position.outcome}`}
              position={position}
            />
          ))}
        </List>
      )}
    </>
  );
}

export interface PolymarketSpatialViewProps {
  snapshot: PolymarketSnapshot;
  /** Dispatch by action id: `market:<id>` (open a market), `detail-back`, `refresh`. */
  onAction?: (action: string) => void;
  /** True when the shell's compact chat composer reserves the inline-end edge. */
  compactChatClearance?: boolean;
}

export function PolymarketSpatialView({
  snapshot,
  onAction,
  compactChatClearance = false,
}: PolymarketSpatialViewProps) {
  const { status, markets, selectedMarket, loading, error } = snapshot;
  const showInlineControls = isEvaluatingToIR();
  const positions = snapshot.positions ?? [];
  const accountReady = status?.account?.ready ?? false;
  const selectedId = selectedMarket?.id ?? null;
  return (
    <Card gap={1} padding={1}>
      {/* The header earns its place only on the list surface; detail mode gives
          the question the full card. Inline Refresh renders only when evaluating
          to terminal IR — the GUI agent-surface reaches refresh through the
          wrapper's hidden control, and the chat composer drives user refresh. */}
      {!selectedMarket ? (
        <HStack gap={1} align="center" wrap>
          <ReadinessRow status={status} />
          <Text style="caption" tone="muted" grow={1}>
            {loading ? "loading" : `${markets.length} markets`}
          </Text>
          {showInlineControls ? (
            <Button
              variant="outline"
              tone="default"
              agent="refresh"
              disabled={loading}
              onPress={() => onAction?.("refresh")}
            >
              Refresh
            </Button>
          ) : null}
        </HStack>
      ) : null}

      {/* Stale-while-error banner: keep the failure visible over cached content
          (detail overlay or a populated list) instead of blanking it. When there
          is no content to preserve, the empty region below owns the error state
          so the message never double-renders (#15781). */}
      {error && (selectedMarket || markets.length > 0) ? (
        <Text tone="danger" style="caption" wrap>
          {error}
        </Text>
      ) : null}

      {selectedMarket ? (
        <MarketDetail
          market={selectedMarket}
          onAction={onAction}
          compact={compactChatClearance}
        />
      ) : (
        <>
          {accountReady ? (
            <PositionsSection
              positions={positions}
              summary={snapshot.positionsSummary ?? null}
            />
          ) : null}
          <Text style="caption" tone="muted">
            markets
          </Text>
          {markets.length > 0 ? (
            <List gap={1}>
              {markets.slice(0, MAX_LIST).map((market, index) => (
                <MarketRow
                  key={market.id}
                  market={market}
                  index={index}
                  active={selectedId === market.id}
                  onAction={onAction}
                />
              ))}
            </List>
          ) : (
            <MarketsEmptyState
              loading={loading ?? false}
              error={error ?? null}
            />
          )}
        </>
      )}
    </Card>
  );
}
