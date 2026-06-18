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
  Divider,
  HStack,
  List,
  type SpatialTone,
  Text,
  VStack,
} from "@elizaos/ui/spatial";
import type {
  PolymarketMarket,
  PolymarketStatusResponse,
} from "../polymarket-contracts";

export interface PolymarketSnapshot {
  status: PolymarketStatusResponse | null;
  markets: readonly PolymarketMarket[];
  /** Detail overlay target; null shows the list. */
  selectedMarket: PolymarketMarket | null;
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

function readyTone(ready: boolean): SpatialTone {
  return ready ? "success" : "muted";
}

function ReadinessRow({ status }: { status: PolymarketStatusResponse | null }) {
  const reads = status?.publicReads.ready ?? false;
  const trading = status?.trading.ready ?? false;
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
}: {
  market: PolymarketMarket;
  index: number;
  active: boolean;
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

      <HStack gap={2} wrap>
        <Text style="caption" tone="muted">
          {`Volume ${shortNumber(market.volume) ?? "-"}`}
        </Text>
        <Text style="caption" tone="muted">
          {`Liquidity ${shortNumber(market.liquidity) ?? "-"}`}
        </Text>
        <Text style="caption" tone="muted">
          {`Last ${lastTrade != null ? `${lastTrade}%` : "-"}`}
        </Text>
      </HStack>

      <Divider label="outcomes" />
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

      <Divider label="orderbook tokens" />
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
  );
}

export interface PolymarketSpatialViewProps {
  snapshot: PolymarketSnapshot;
  /** Dispatch by agent id: `market:<id>`, `detail-back`, `refresh`. */
  onAction?: (action: string) => void;
}

export function PolymarketSpatialView({
  snapshot,
  onAction,
}: PolymarketSpatialViewProps) {
  const { status, markets, selectedMarket, loading, error } = snapshot;
  const selectedId = selectedMarket?.id ?? null;
  return (
    <Card title="Polymarket" gap={1} padding={1}>
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
          <Divider label="markets" />
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
                />
              ))}
            </List>
          )}
        </>
      )}
    </Card>
  );
}
