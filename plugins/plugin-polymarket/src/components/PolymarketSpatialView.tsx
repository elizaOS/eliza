/**
 * PolymarketSpatialView - the Polymarket markets surface authored once with the
 * spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives plus a type-only view of
 * the Polymarket contracts, so it is safe to render in the Node agent process
 * where the terminal lives (no app-core/client runtime import).
 */

import {
  Button,
  Card,
  HStack,
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

const MAX_LIST = 24;
const MAX_OUTCOMES = 3;

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

function OutcomeLine({
  name,
  percent,
  lead,
}: {
  name: string;
  percent: number | null;
  lead: boolean;
}) {
  return (
    <HStack gap={1} align="center">
      <Text tone={lead ? "primary" : "default"} grow={1} wrap={false}>
        {name}
      </Text>
      <Text
        style="caption"
        tone={lead ? "primary" : "muted"}
        align="end"
        width={6}
      >
        {percent != null ? `${percent}%` : "n/a"}
      </Text>
    </HStack>
  );
}

function outcomeSummary(outcome: PolymarketMarket["outcomes"][number]): string {
  const percent = priceToPercent(outcome.price);
  return `${outcome.name} ${percent != null ? `${percent}%` : "n/a"}`;
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
}: {
  market: PolymarketMarket;
  onAction?: (action: string) => void;
}) {
  const lastTrade = priceToPercent(market.lastTradePrice);
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
      {market.category ? (
        <Text style="caption" tone="muted">
          {market.category}
        </Text>
      ) : null}

      <HStack gap={2} align="center">
        <Text style="caption" tone="muted" wrap={false}>
          {`Volume ${shortNumber(market.volume) ?? "-"}`}
        </Text>
        <Text style="caption" tone="muted" wrap={false}>
          {`Liquidity ${shortNumber(market.liquidity) ?? "-"}`}
        </Text>
        <Text style="caption" tone="muted" wrap={false}>
          {`Last ${lastTrade != null ? `${lastTrade}%` : "-"}`}
        </Text>
      </HStack>

      <VStack gap={0}>
        <Text style="caption" tone="muted">
          outcomes
        </Text>
        <List gap={0}>
          {market.outcomes.map((outcome, i) => (
            <OutcomeLine
              key={outcome.name}
              name={outcome.name}
              percent={priceToPercent(outcome.price)}
              lead={i === 0}
            />
          ))}
        </List>
      </VStack>

      <VStack gap={0}>
        <Text style="caption" tone="muted">
          orderbook tokens
        </Text>
        {market.clobTokenIds.length > 0 ? (
          <List gap={0}>
            {market.clobTokenIds.map((tokenId) => (
              <Text key={tokenId} style="caption" tone="muted" wrap={false}>
                {tokenId}
              </Text>
            ))}
          </List>
        ) : (
          <Text style="caption" tone="muted">
            no CLOB token ids
          </Text>
        )}
      </VStack>
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
          {open.map((position) => (
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
}

export function PolymarketSpatialView({
  snapshot,
  onAction,
}: PolymarketSpatialViewProps) {
  const { status, markets, selectedMarket, loading, error } = snapshot;
  const positions = snapshot.positions ?? [];
  const accountReady = status?.account?.ready ?? false;
  const selectedId = selectedMarket?.id ?? null;
  return (
    <Card gap={1} padding={1}>
      <HStack gap={1} align="center" wrap>
        <ReadinessRow status={status} />
        <Text style="caption" tone="muted" grow={1}>
          {loading ? "loading" : `${markets.length} markets`}
        </Text>
        <Button
          variant="outline"
          tone="default"
          agent="refresh"
          disabled={loading}
          onPress={() => onAction?.("refresh")}
        >
          Refresh
        </Button>
      </HStack>

      {error ? (
        <Text tone="danger" style="caption">
          {error}
        </Text>
      ) : null}

      {selectedMarket ? (
        <MarketDetail market={selectedMarket} onAction={onAction} />
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
          {markets.length === 0 ? (
            <Text tone="muted" align="center" style="caption">
              {loading ? "loading markets" : "no markets loaded"}
            </Text>
          ) : (
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
          )}
        </>
      )}
    </Card>
  );
}
