/**
 * InventoryAppView — the full-screen wallet dashboard.
 *
 * It owns the rich multi-panel surface — holdings rail (tokens / DeFi / NFTs),
 * P&L window selector + chart, activity log, portfolio movers, LP positions, and
 * the NFT grid — backed by the app store + live trading-profile / market-overview
 * fetches.
 *
 * It is no longer registered as a separate app/nav tab. The unified
 * {@link InventoryView} renders it as the real-DOM child of its `Escape` hatch,
 * so GUI / XR get this full dashboard while TUI falls back to the spatial
 * `InventorySpatialView`. This is the DOM-only dashboard reached only through
 * that wrapper.
 */
import type {
  WalletConfigStatus,
  WalletMarketMover,
  WalletMarketOverviewResponse,
  WalletMarketOverviewSource,
  WalletMarketPriceSnapshot,
  WalletTradingProfileResponse,
  WalletTradingProfileWindow,
} from "@elizaos/shared";
// Direct subpath: the app renderer resolves the bare `@elizaos/ui` root to the
// browser barrel, which doesn't reliably re-export this newer component.
import { ChatEmptyStateWithRecommendations } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { client } from "@elizaos/ui/api";
import { Button } from "@elizaos/ui/components";
import { type ActivityEvent, useActivityEvents } from "@elizaos/ui/hooks";
import type { InventoryChainFilters } from "@elizaos/ui/state";
import { useAppSelectorShallow } from "@elizaos/ui/state";
import { cn } from "@elizaos/ui/utils";
import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  CheckCircle2,
  Copy,
  EyeOff,
  Image as ImageIcon,
  Layers3,
  type LucideIcon,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { resolveWalletAddresses } from "../InventoryView.helpers";
import { getNativeLogoUrl } from "../inventory/chainConfig.ts";
import {
  formatBalance,
  type NftItem,
  type TokenRow,
} from "../inventory/constants.ts";
import { TokenLogo } from "../inventory/TokenLogo.tsx";
import { useInventoryData } from "../inventory/useInventoryData.ts";

type DashboardWindow = "24h" | "7d" | "30d";
type WalletRailTab = "tokens" | "defi" | "nfts";

const ALL_INVENTORY_FILTERS: InventoryChainFilters = {
  ethereum: true,
  base: true,
  bsc: true,
  avax: true,
  solana: true,
};
const SUPPORTED_WALLET_CHAINS = Object.keys(ALL_INVENTORY_FILTERS);

const DASHBOARD_WINDOWS: DashboardWindow[] = ["24h", "7d", "30d"];
const HIDDEN_TOKEN_IDS_KEY = "eliza:wallet:hidden-token-ids:v1";
const WALLET_REFRESH_INTERVAL_MS = 20_000;
interface InventoryPositionAsset {
  id: string;
  kind: "token" | "nft";
  label: string;
  detail: string;
  valueUsd: number | null;
  imageUrl: string | null;
}

interface PortfolioMover {
  row: TokenRow;
  realizedPnlBnb: number;
}

interface WalletTimelineEntry {
  id: string;
  timestamp: number;
  title: string;
  detail?: string;
  href?: string;
  icon: LucideIcon;
  tone?: "default" | "ok" | "warn" | "danger";
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const compactFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 4,
});

function readHiddenTokenIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(HIDDEN_TOKEN_IDS_KEY);
    if (!raw) return new Set();

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((item): item is string => typeof item === "string"),
    );
  } catch {
    return new Set();
  }
}

function writeHiddenTokenIds(next: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      HIDDEN_TOKEN_IDS_KEY,
      JSON.stringify([...next]),
    );
  } catch {
    return;
  }
}

function tokenId(row: TokenRow): string {
  const address =
    row.contractAddress && row.contractAddress.length > 0
      ? row.contractAddress.toLowerCase()
      : `native:${row.symbol.toLowerCase()}`;
  return `${row.chain.toLowerCase()}:${address}`;
}

/** Kebab-cased, agent-surface-safe id slug for a single token row. */
function tokenAgentSlug(row: TokenRow): string {
  return tokenId(row)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function normalizeTokenAddress(address: string | null): string | null {
  return address ? address.toLowerCase() : null;
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return usdFormatter.format(0);
  return usdFormatter.format(value);
}

function formatMarketUsd(value: number): string {
  if (!Number.isFinite(value)) return usdFormatter.format(0);
  const fractionDigits =
    value >= 1_000 ? 0 : value >= 1 ? 2 : value >= 0.01 ? 4 : 6;
  const minimumFractionDigits = value >= 1 ? Math.min(2, fractionDigits) : 0;
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function formatPercentDelta(value: number): string {
  if (!Number.isFinite(value)) return "0.0%";
  const magnitude = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${magnitude}%`;
}

function formatCompactAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 5)}...${address.slice(-4)}`;
}

function formatBnb(value: string | null | undefined): string {
  if (!value) return "0 BNB";
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return `${value} BNB`;
  return `${compactFormatter.format(parsed)} BNB`;
}

function parseAmount(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatSignedBnb(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${compactFormatter.format(Math.abs(value))} BNB`;
}

function hasClosedTradePnl(
  profile: WalletTradingProfileResponse | null,
): boolean {
  return (profile?.summary.evaluatedTrades ?? 0) > 0;
}

function providerLabel(
  provider: string | null | undefined,
  chain?: "evm" | "bsc" | "solana",
): string {
  switch (provider) {
    case "eliza-cloud":
      return chain === "solana" ? "Eliza Cloud / Helius" : "Eliza Cloud";
    case "alchemy":
      return "Alchemy";
    case "quicknode":
      return "QuickNode";
    case "helius-birdeye":
      return "Helius + Birdeye";
    case "custom":
      return "Custom";
    default:
      return "Not configured";
  }
}

function formatRelativeTimestamp(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 0) return "now";
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function tradingProfileWindow(
  window: DashboardWindow,
): WalletTradingProfileWindow {
  return window === "24h" ? "24h" : window;
}

function tokenHasInventory(row: TokenRow): boolean {
  return row.balanceRaw > 0 || row.valueUsd > 0;
}

function assetAllocationRows(rows: TokenRow[]): TokenRow[] {
  return rows
    .filter((row) => row.valueUsd > 0)
    .sort((left, right) => right.valueUsd - left.valueUsd)
    .slice(0, 5);
}

function looksLikeLpPosition(value: string): boolean {
  const text = ` ${value.toLowerCase()} `;
  return (
    text.includes(" liquidity ") ||
    text.includes(" lp ") ||
    text.includes("-lp") ||
    text.includes("/lp") ||
    text.includes(" pool ") ||
    text.includes(" position ") ||
    text.includes(" clmm ") ||
    text.includes(" amm ")
  );
}

function deriveInventoryPositionAssets({
  tokenRows,
  nfts,
}: {
  tokenRows: TokenRow[];
  nfts: NftItem[];
}): InventoryPositionAsset[] {
  const positions: InventoryPositionAsset[] = [];

  for (const row of tokenRows) {
    if (!looksLikeLpPosition(`${row.name} ${row.symbol}`)) continue;
    positions.push({
      id: `token:${tokenId(row)}`,
      kind: "token",
      label: row.symbol,
      detail: `${formatBalance(row.balance)} ${row.symbol}`,
      valueUsd: row.valueUsd,
      imageUrl: row.logoUrl,
    });
  }

  for (const nft of nfts) {
    if (!looksLikeLpPosition(`${nft.collectionName} ${nft.name}`)) continue;
    positions.push({
      id: `nft:${nft.collectionName}:${nft.name}:${nft.imageUrl}`,
      kind: "nft",
      label: nft.name,
      detail: nft.collectionName,
      valueUsd: null,
      imageUrl: nft.imageUrl,
    });
  }

  return positions;
}

function tokenBreakdownForRow(
  row: TokenRow,
  profile: WalletTradingProfileResponse | null,
) {
  const normalizedAddress = normalizeTokenAddress(row.contractAddress);
  if (!normalizedAddress || !profile) return null;
  return (
    profile.tokenBreakdown.find(
      (item) => item.tokenAddress.toLowerCase() === normalizedAddress,
    ) ?? null
  );
}

function portfolioMovers(
  rows: TokenRow[],
  profile: WalletTradingProfileResponse | null,
): PortfolioMover[] {
  if (!profile) return [];
  return rows
    .map((row) => {
      const breakdown = tokenBreakdownForRow(row, profile);
      const realizedPnlBnb = parseAmount(breakdown?.realizedPnlBnb);
      if (realizedPnlBnb === null || realizedPnlBnb === 0) return null;
      return {
        row,
        realizedPnlBnb,
      };
    })
    .filter((mover): mover is PortfolioMover => mover !== null);
}

function TokenPerformance({
  row,
  profile,
  maxAbsPnl,
}: {
  row: TokenRow;
  profile: WalletTradingProfileResponse | null;
  maxAbsPnl: number;
}) {
  const breakdown = tokenBreakdownForRow(row, profile);

  if (!breakdown) {
    return null;
  }

  const pnl = parseAmount(breakdown.realizedPnlBnb);
  if (pnl === null) return null;

  const width =
    maxAbsPnl > 0 ? Math.max(18, (Math.abs(pnl) / maxAbsPnl) * 56) : 18;
  const TrendIcon = pnl >= 0 ? TrendingUp : TrendingDown;
  const tone = pnl === 0 ? "text-muted" : pnl > 0 ? "text-txt" : "text-danger";
  const barTone =
    pnl === 0 ? "bg-border" : pnl > 0 ? "bg-txt/70" : "bg-danger/80";

  return (
    <span className="flex min-w-[4.5rem] flex-col items-end gap-1">
      <span
        className={cn(
          "inline-flex items-center gap-1 text-[0.68rem] font-medium",
          tone,
        )}
      >
        <TrendIcon className="h-3 w-3" />
        {pnl > 0 ? "+" : ""}
        {formatBnb(breakdown.realizedPnlBnb)}
      </span>
      <span
        className="flex h-1.5 w-14 justify-end overflow-hidden rounded-full bg-border/45"
        aria-hidden="true"
      >
        <span
          className={cn("h-full rounded-full", barTone)}
          style={{ width }}
        />
      </span>
    </span>
  );
}

function maxAbsTokenPnl(
  rows: TokenRow[],
  profile: WalletTradingProfileResponse | null,
): number {
  if (!profile) return 0;
  let max = 0;
  for (const row of rows) {
    const breakdown = tokenBreakdownForRow(row, profile);
    const pnl = parseAmount(breakdown?.realizedPnlBnb);
    if (pnl !== null) max = Math.max(max, Math.abs(pnl));
  }
  return max;
}

function ChainLogoBadge({
  chain,
  size = 18,
  className,
  testId,
}: {
  chain: string;
  size?: number;
  className?: string;
  testId?: string;
}) {
  const [errored, setErrored] = useState(false);
  const logoUrl = errored ? null : getNativeLogoUrl(chain);

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-bg ring-2 ring-bg",
        className,
      )}
      style={{ width: size, height: size }}
      title={chain}
      role="img"
      aria-label={chain}
      data-testid={testId}
    >
      {logoUrl ? (
        <img
          src={logoUrl}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setErrored(true)}
        />
      ) : (
        <span className="font-mono text-[0.58rem] font-bold uppercase text-muted">
          {chain.charAt(0)}
        </span>
      )}
    </span>
  );
}

function TokenIdentityIcon({
  row,
  size = 46,
}: {
  row: TokenRow;
  size?: number;
}) {
  const badgeSize = Math.max(16, Math.round(size * 0.38));
  return (
    <span
      className="relative inline-flex shrink-0"
      style={{ width: size, height: size }}
    >
      <TokenLogo
        symbol={row.symbol}
        chain={row.chain}
        contractAddress={row.contractAddress}
        preferredLogoUrl={row.logoUrl}
        size={size}
      />
      <ChainLogoBadge
        chain={row.chain}
        size={badgeSize}
        className="-bottom-0.5 -right-0.5 absolute"
      />
    </span>
  );
}

function allocationToneClass(index: number): string {
  return index === 0
    ? "bg-accent"
    : index === 1
      ? "bg-accent/70"
      : index === 2
        ? "bg-accent/45"
        : index === 3
          ? "bg-muted/60"
          : "bg-muted/35";
}

function AssetAllocationStrip({
  rows,
  compact = false,
}: {
  rows: TokenRow[];
  compact?: boolean;
}) {
  const allocationRows = useMemo(() => assetAllocationRows(rows), [rows]);
  const total = allocationRows.reduce((sum, row) => sum + row.valueUsd, 0);
  if (total <= 0 || allocationRows.length === 0) return null;

  return (
    <div className={cn("space-y-2", compact && "space-y-3")}>
      <div
        className={cn(
          "flex overflow-hidden rounded-full bg-border/40",
          compact ? "h-2.5" : "h-2",
        )}
      >
        {allocationRows.map((row, index) => (
          <span
            key={tokenId(row)}
            className={cn("h-full", allocationToneClass(index))}
            style={{ width: `${(row.valueUsd / total) * 100}%` }}
            title={`${row.symbol}: ${formatUsd(row.valueUsd)}`}
          />
        ))}
      </div>
      {compact ? (
        <div className="flex flex-wrap gap-2">
          {allocationRows.slice(0, 3).map((row, index) => (
            <div
              key={tokenId(row)}
              className="inline-flex items-center gap-1.5 text-[0.68rem] font-medium text-txt"
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  allocationToneClass(index),
                )}
              />
              <span>{row.symbol}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-1">
          {allocationRows.slice(0, 3).map((row) => (
            <div
              key={tokenId(row)}
              className="flex items-center justify-between gap-2 text-[0.68rem]"
            >
              <span className="truncate text-muted">{row.symbol}</span>
              <span className="shrink-0 font-mono text-txt">
                {formatUsd(row.valueUsd)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PortfolioMoverRow({
  mover,
  maxAbsPnl,
}: {
  mover: PortfolioMover;
  maxAbsPnl: number;
}) {
  const isGain = mover.realizedPnlBnb > 0;
  const width =
    maxAbsPnl > 0
      ? Math.max(18, (Math.abs(mover.realizedPnlBnb) / maxAbsPnl) * 100)
      : 18;

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-1 py-2">
      <TokenIdentityIcon row={mover.row} size={34} />
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-txt">
          {mover.row.symbol}
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border/45">
          <div
            className={cn(
              "h-full rounded-full",
              isGain ? "bg-txt/70" : "bg-danger/85",
            )}
            style={{ width: `${width}%` }}
          />
        </div>
      </div>
      <div
        className={cn(
          "shrink-0 text-right font-mono text-xs font-semibold",
          isGain ? "text-txt" : "text-danger",
        )}
      >
        {formatSignedBnb(mover.realizedPnlBnb)}
      </div>
    </div>
  );
}

function PortfolioMoverColumn({
  title,
  movers,
  maxAbsPnl,
  tone,
}: {
  title: string;
  movers: PortfolioMover[];
  maxAbsPnl: number;
  tone: "gain" | "loss";
}) {
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-center gap-2 text-sm font-semibold text-txt">
        {tone === "gain" ? (
          <TrendingUp className="h-3.5 w-3.5 text-muted" />
        ) : (
          <TrendingDown className="h-3.5 w-3.5 text-danger" />
        )}
        {title}
      </div>
      {movers.length > 0 ? (
        <div className="space-y-1">
          {movers.map((mover) => (
            <PortfolioMoverRow
              key={`${tokenId(mover.row)}:${mover.realizedPnlBnb}`}
              mover={mover}
              maxAbsPnl={maxAbsPnl}
            />
          ))}
        </div>
      ) : (
        <div className="flex h-[3.75rem] items-center px-1 text-xs-tight text-muted">
          None
        </div>
      )}
    </div>
  );
}

function PortfolioMoversPanel({
  rows,
  profile,
  marketOverview,
}: {
  rows: TokenRow[];
  profile: WalletTradingProfileResponse | null;
  marketOverview: WalletMarketOverviewResponse | null;
}) {
  const movers = useMemo(() => portfolioMovers(rows, profile), [rows, profile]);
  const gainers = useMemo(
    () =>
      movers
        .filter((mover) => mover.realizedPnlBnb > 0)
        .sort((left, right) => right.realizedPnlBnb - left.realizedPnlBnb)
        .slice(0, 3),
    [movers],
  );
  const losers = useMemo(
    () =>
      movers
        .filter((mover) => mover.realizedPnlBnb < 0)
        .sort((left, right) => left.realizedPnlBnb - right.realizedPnlBnb)
        .slice(0, 3),
    [movers],
  );
  const maxAbsPnl = useMemo(
    () =>
      movers.reduce(
        (max, mover) => Math.max(max, Math.abs(mover.realizedPnlBnb)),
        0,
      ),
    [movers],
  );

  if (movers.length === 0) {
    if (marketOverview?.movers.length) {
      return (
        <MarketMoverList
          movers={marketOverview.movers}
          source={marketOverview.sources.movers}
        />
      );
    }

    return (
      <ChatEmptyStateWithRecommendations
        icon={TrendingUp}
        className="min-h-[8rem]"
        recommendations={[
          "What tokens are trending right now?",
          "Which of my holdings moved most this week?",
          "Find new tokens to watch on Base",
        ]}
      />
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <PortfolioMoverColumn
        title="Gainers"
        movers={gainers}
        maxAbsPnl={maxAbsPnl}
        tone="gain"
      />
      <PortfolioMoverColumn
        title="Losers"
        movers={losers}
        maxAbsPnl={maxAbsPnl}
        tone="loss"
      />
    </div>
  );
}

function MarketAvatar({
  imageUrl,
  label,
}: {
  imageUrl: string | null;
  label: string;
}) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={label}
        className="h-11 w-11 shrink-0 object-cover"
        loading="lazy"
      />
    );
  }

  return (
    <div className="flex h-11 w-11 shrink-0 items-center justify-center text-sm font-semibold text-txt">
      {label.slice(0, 1).toUpperCase()}
    </div>
  );
}

function MarketSourceBadge({ source }: { source: WalletMarketOverviewSource }) {
  return (
    <a
      href={source.providerUrl}
      target="_blank"
      rel="noreferrer"
      className="text-[0.68rem] font-medium text-muted transition-colors hover:text-txt"
    >
      {source.providerName}
    </a>
  );
}

function MarketDataUnavailable({
  title,
  source,
}: {
  title: string;
  source: WalletMarketOverviewSource;
}) {
  return (
    <div className="px-1 py-2" title={`${title} unavailable`}>
      <div className="text-sm font-semibold text-warn">Unavailable</div>
      <div className="mt-1 text-xs text-muted">
        {source.error ?? `${source.providerName} did not return live data.`}
      </div>
    </div>
  );
}

function MajorPriceCard({ snapshot }: { snapshot: WalletMarketPriceSnapshot }) {
  const isPositive = snapshot.change24hPct >= 0;

  return (
    <div className="min-w-0 p-2">
      <div className="flex items-center gap-3">
        <MarketAvatar imageUrl={snapshot.imageUrl} label={snapshot.symbol} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-txt">
            {snapshot.symbol}
          </div>
          <div className="truncate text-xs-tight text-muted">
            {snapshot.name}
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 font-mono text-lg font-semibold text-txt sm:text-xl">
          {formatMarketUsd(snapshot.priceUsd)}
        </div>
        <div
          className={cn(
            "shrink-0 text-sm font-semibold",
            isPositive ? "text-txt" : "text-danger",
          )}
        >
          {formatPercentDelta(snapshot.change24hPct)}
        </div>
      </div>
    </div>
  );
}

function MarketPriceGrid({
  prices,
  source,
}: {
  prices: WalletMarketPriceSnapshot[];
  source: WalletMarketOverviewSource;
}) {
  if (!source.available) {
    return <MarketDataUnavailable title="Spot prices" source={source} />;
  }

  if (prices.length === 0) {
    return (
      <ChatEmptyStateWithRecommendations
        icon={BarChart3}
        className="min-h-[8rem]"
        recommendations={[
          "What's the price of ETH right now?",
          "Show me BTC and SOL prices",
        ]}
      />
    );
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,13.5rem),1fr))] gap-3">
      {prices.map((snapshot) => (
        <MajorPriceCard key={snapshot.id} snapshot={snapshot} />
      ))}
    </div>
  );
}

function MarketMoverList({
  movers,
  source,
}: {
  movers: WalletMarketMover[];
  source: WalletMarketOverviewSource;
}) {
  if (!source.available) {
    return <MarketDataUnavailable title="Top movers" source={source} />;
  }

  if (movers.length === 0) {
    return (
      <ChatEmptyStateWithRecommendations
        icon={TrendingUp}
        className="min-h-[8rem]"
        recommendations={[
          "What are today's top gainers?",
          "Which tokens are moving on Solana?",
        ]}
      />
    );
  }

  return (
    <div className="space-y-2">
      {movers.map((mover) => {
        const isPositive = mover.change24hPct >= 0;
        return (
          <div
            key={mover.id}
            className="flex min-w-0 items-center gap-3 px-1 py-2.5"
          >
            <MarketAvatar imageUrl={mover.imageUrl} label={mover.symbol} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-semibold text-txt">
                  {mover.symbol}
                </span>
                <span className="truncate text-xs-tight text-muted">
                  {mover.name}
                </span>
              </div>
              {mover.marketCapRank !== null ? (
                <div className="mt-1 text-[0.68rem] font-medium text-muted">
                  Cap rank #{mover.marketCapRank}
                </div>
              ) : null}
            </div>
            <div className="shrink-0 text-right">
              <div className="font-mono text-sm font-semibold text-txt">
                {formatMarketUsd(mover.priceUsd)}
              </div>
              <div
                className={cn(
                  "text-xs font-semibold",
                  isPositive ? "text-txt" : "text-danger",
                )}
              >
                {formatPercentDelta(mover.change24hPct)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WalletMotif() {
  return (
    <svg
      viewBox="0 0 120 120"
      role="img"
      aria-label="Empty wallet"
      className="h-24 w-24"
    >
      <defs>
        <linearGradient id="walletMotifFill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.9" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.35" />
        </linearGradient>
      </defs>
      <circle
        cx="60"
        cy="60"
        r="56"
        fill="url(#walletMotifFill)"
        opacity="0.12"
      />
      <rect
        x="30"
        y="42"
        width="60"
        height="40"
        rx="10"
        fill="url(#walletMotifFill)"
        opacity="0.85"
      />
      <rect
        x="30"
        y="42"
        width="60"
        height="14"
        rx="7"
        fill="var(--accent)"
        opacity="0.5"
      />
      <circle cx="78" cy="62" r="6" fill="var(--bg)" opacity="0.85" />
      <circle cx="78" cy="62" r="2.5" fill="var(--accent)" />
    </svg>
  );
}

function WalletEmptyHero({
  hasKeys,
  onConfigureKeys,
}: {
  hasKeys: boolean;
  onConfigureKeys: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
      <WalletMotif />
      {hasKeys ? null : (
        <Button
          type="button"
          variant="surfaceAccent"
          size="sm"
          onClick={onConfigureKeys}
        >
          Keys
        </Button>
      )}
    </div>
  );
}

function MarketPulseHero({
  overview,
  loading,
  hasKeys,
  onConfigureKeys,
}: {
  overview: WalletMarketOverviewResponse | null;
  loading: boolean;
  hasKeys: boolean;
  onConfigureKeys: () => void;
}) {
  return (
    <section className="space-y-6">
      <WalletEmptyHero hasKeys={hasKeys} onConfigureKeys={onConfigureKeys} />

      {overview ? (
        <div className="space-y-6">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 text-xs text-muted">
              <span>Spot prices</span>
              <MarketSourceBadge source={overview.sources.prices} />
            </div>
            <MarketPriceGrid
              prices={overview.prices}
              source={overview.sources.prices}
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 text-xs text-muted">
              <span>Top movers</span>
              <MarketSourceBadge source={overview.sources.movers} />
            </div>
            <MarketMoverList
              movers={overview.movers}
              source={overview.sources.movers}
            />
          </div>
        </div>
      ) : loading ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,13.5rem),1fr))] gap-3">
          {["btc", "eth", "sol"].map((loadingCardId) => (
            <div key={loadingCardId} className="h-28 animate-pulse bg-bg/20" />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function activityEventMeta(eventType: string): {
  icon: LucideIcon;
  tone: WalletTimelineEntry["tone"];
} {
  if (eventType === "task_complete" || eventType === "blocked_auto_resolved") {
    return { icon: Sparkles, tone: "ok" };
  }
  if (eventType === "blocked" || eventType === "escalation") {
    return { icon: Activity, tone: "warn" };
  }
  if (eventType === "error") {
    return { icon: Activity, tone: "danger" };
  }
  return { icon: Activity, tone: "default" };
}

function walletTimelineEntries({
  profile,
  events,
}: {
  profile: WalletTradingProfileResponse | null;
  events: ActivityEvent[];
}): WalletTimelineEntry[] {
  const swapEntries = (profile?.recentSwaps ?? []).reduce<
    WalletTimelineEntry[]
  >((entries, swap) => {
    const timestamp = Date.parse(swap.createdAt);
    if (!Number.isFinite(timestamp)) return entries;
    entries.push({
      id: `swap:${swap.hash}`,
      timestamp,
      title: `${swap.side === "buy" ? "Bought" : "Sold"} ${swap.tokenSymbol}`,
      detail: `${swap.inputAmount} ${swap.inputSymbol} -> ${swap.outputAmount} ${swap.outputSymbol}`,
      href: swap.explorerUrl,
      icon: ArrowLeftRight,
      tone:
        swap.status === "success"
          ? "ok"
          : swap.status === "pending"
            ? "warn"
            : "danger",
    });
    return entries;
  }, []);
  const agentEntries: WalletTimelineEntry[] = events.map((event) => {
    const meta = activityEventMeta(event.eventType);
    return {
      id: `agent:${event.id}`,
      timestamp: event.timestamp,
      title: event.summary,
      icon: meta.icon,
      tone: meta.tone,
    };
  });

  return [...swapEntries, ...agentEntries]
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, 18);
}

function PnlChart({
  profile,
}: {
  profile: WalletTradingProfileResponse | null;
}) {
  const points = profile?.pnlSeries ?? [];
  const values = points
    .map((point) => parseAmount(point.realizedPnlBnb))
    .filter((value): value is number => value !== null);

  if (values.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center text-xs text-muted">
        Trade to see your P&amp;L here
      </div>
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const svgPoints = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      const y = 88 - ((value - min) / span) * 72;
      return `${x},${y}`;
    })
    .join(" ");
  const latest = values[values.length - 1];
  const stroke = latest >= 0 ? "var(--muted-strong)" : "var(--danger)";

  return (
    <svg
      className="h-40 w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-label="Trade P&L chart"
    >
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={svgPoints}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function SummaryChip({
  icon: Icon,
  value,
  tone = "default",
  title,
}: {
  icon: LucideIcon;
  value: string;
  tone?: "default" | "gain" | "loss";
  title?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 px-1 py-1.5 text-sm font-medium",
        tone === "loss" ? "text-danger" : "text-txt",
      )}
      title={title}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span>{value}</span>
    </div>
  );
}

function WalletRailAddress({
  address,
  chains,
  emptyLabel,
  label,
  agentId,
  agentLabel,
}: {
  address: string | null;
  chains: string[];
  emptyLabel: string;
  label: string;
  /** Stable agent-surface id so the agent can copy this address by name. */
  agentId: string;
  /** Human/agent-facing label for the copy action. */
  agentLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!address) return;
    void navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [address]);

  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label: agentLabel,
    group: "wallet-account",
    status: address ? undefined : "inactive",
    description: `Copy the ${agentLabel} to the clipboard`,
  });

  return (
    <Button
      unstyled
      ref={ref}
      type="button"
      className={cn(
        "group inline-flex min-h-10 min-w-0 items-center gap-2 rounded-sm px-2 py-2 text-left transition-colors [@media(orientation:landscape)_and_(max-height:520px)]:min-h-8 [@media(orientation:landscape)_and_(max-height:520px)]:py-1",
        address ? "text-txt hover:text-accent" : "text-muted",
      )}
      onClick={handleCopy}
      disabled={!address}
      title={address ?? emptyLabel}
      aria-label={
        address ? `Copy ${emptyLabel} address` : `${emptyLabel} unavailable`
      }
      data-testid={`wallet-copy-${emptyLabel.toLowerCase()}-address`}
      {...agentProps}
    >
      <span className="flex shrink-0 -space-x-1.5">
        {chains.map((chain) => (
          <ChainLogoBadge
            key={chain}
            chain={chain}
            size={18}
            className="ring-1 ring-bg"
            testId={`wallet-address-chain-chip-${chain}`}
          />
        ))}
      </span>
      <span className="shrink-0 text-[0.68rem] font-medium text-muted">
        {label}
      </span>
      <span
        className={cn(
          "min-w-0 truncate font-mono text-xs font-semibold",
          address ? "max-w-24 text-txt" : "max-w-20 text-muted",
        )}
      >
        {address ? formatCompactAddress(address) : emptyLabel}
      </span>
      {address ? (
        copied ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent" />
        ) : (
          <Copy className="h-3.5 w-3.5 shrink-0 text-muted transition-colors group-hover:text-txt" />
        )
      ) : (
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warn" />
      )}
    </Button>
  );
}

function WalletConnectionChip({
  label,
  ready,
}: {
  label: string;
  ready: boolean;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[0.68rem] font-medium text-muted"
      title={`${label} ${ready ? "ready" : "needs RPC"}`}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          ready ? "bg-muted/60" : "bg-warn",
        )}
      />
      {label}
    </span>
  );
}

function WalletChainCluster() {
  return (
    <span className="flex shrink-0 -space-x-1.5">
      {SUPPORTED_WALLET_CHAINS.map((chain) => (
        <ChainLogoBadge
          key={chain}
          chain={chain}
          size={18}
          className="ring-1 ring-bg"
          testId={`wallet-chain-chip-${chain}`}
        />
      ))}
    </span>
  );
}

function WalletAddressCluster({
  addresses,
}: {
  addresses: { evmAddress: string | null; solanaAddress: string | null };
}) {
  return (
    <div className="flex min-w-0 flex-wrap gap-2">
      <WalletRailAddress
        address={addresses.evmAddress}
        chains={SUPPORTED_WALLET_CHAINS.filter((chain) => chain !== "solana")}
        emptyLabel="EVM"
        label="EVM"
        agentId="account-copy-evm-address"
        agentLabel="EVM address"
      />
      <WalletRailAddress
        address={addresses.solanaAddress}
        chains={["solana"]}
        emptyLabel="SOL"
        label="SOL"
        agentId="account-copy-solana-address"
        agentLabel="Solana address"
      />
    </div>
  );
}

function WalletProviderDots({
  walletConfig,
}: {
  walletConfig: WalletConfigStatus | null;
}) {
  const allReady =
    Boolean(walletConfig?.evmBalanceReady) &&
    Boolean(walletConfig?.solanaBalanceReady);
  return (
    <span
      className={cn(
        "h-2 w-2 rounded-full",
        allReady ? "bg-muted/60" : "bg-warn",
      )}
    />
  );
}

function WalletRailRpcButton({
  walletConfig,
  onOpenSettings,
}: {
  walletConfig: WalletConfigStatus | null;
  onOpenSettings: () => void;
}) {
  const evmProvider = providerLabel(
    walletConfig?.selectedRpcProviders?.evm,
    "evm",
  );
  const solanaProvider = providerLabel(
    walletConfig?.selectedRpcProviders?.solana,
    "solana",
  );

  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "account-rpc-settings",
    role: "button",
    label: "RPC settings",
    group: "wallet-account",
    description: `Open RPC provider settings (EVM ${evmProvider}, Solana ${solanaProvider})`,
  });

  return (
    <Button
      unstyled
      ref={ref}
      type="button"
      className="inline-flex min-h-10 items-center gap-2 rounded-sm px-3 text-xs font-semibold text-txt transition-colors hover:text-accent [@media(orientation:landscape)_and_(max-height:520px)]:min-h-8 [@media(orientation:landscape)_and_(max-height:520px)]:px-2"
      onClick={onOpenSettings}
      title={`RPC providers: EVM ${evmProvider}, Solana ${solanaProvider}`}
      aria-label="Open RPC settings"
      {...agentProps}
    >
      <WalletProviderDots walletConfig={walletConfig} />
      RPC
    </Button>
  );
}

function WalletRailAccount({
  addresses,
  portfolioValueUsd,
  walletConfig,
  onOpenSettings,
}: {
  addresses: { evmAddress: string | null; solanaAddress: string | null };
  portfolioValueUsd: number;
  walletConfig: WalletConfigStatus | null;
  onOpenSettings: () => void;
}) {
  const evmReady = Boolean(walletConfig?.evmBalanceReady);
  const solanaReady = Boolean(walletConfig?.solanaBalanceReady);
  return (
    <div className="space-y-3 [@media(orientation:landscape)_and_(max-height:520px)]:space-y-2">
      <div className="flex flex-wrap items-start gap-3">
        <div className="relative flex h-14 w-14 items-center justify-center [@media(orientation:landscape)_and_(max-height:520px)]:h-10 [@media(orientation:landscape)_and_(max-height:520px)]:w-10">
          <Wallet className="h-6 w-6 text-accent [@media(orientation:landscape)_and_(max-height:520px)]:h-5 [@media(orientation:landscape)_and_(max-height:520px)]:w-5" />
        </div>
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="font-mono text-2xl font-semibold leading-none text-txt [@media(orientation:landscape)_and_(max-height:520px)]:text-xl">
              {formatUsd(portfolioValueUsd)}
            </div>
            <WalletChainCluster />
          </div>
          <div className="mt-2 flex flex-wrap gap-2 [@media(orientation:landscape)_and_(max-height:520px)]:mt-1">
            <WalletConnectionChip label="EVM" ready={evmReady} />
            <WalletConnectionChip label="SOL" ready={solanaReady} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <WalletRailRpcButton
            walletConfig={walletConfig}
            onOpenSettings={onOpenSettings}
          />
        </div>
      </div>
      <WalletAddressCluster addresses={addresses} />
    </div>
  );
}

function WalletRailTabButton({
  tab,
  active,
  onSelect,
}: {
  tab: { id: WalletRailTab; label: string; icon: LucideIcon };
  active: boolean;
  onSelect: (id: WalletRailTab) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `tab-${tab.id}`,
    role: "tab",
    label: tab.label,
    group: "wallet-tabs",
    status: active ? "active" : "inactive",
    description: `Show the ${tab.label} list`,
  });
  return (
    <Button
      unstyled
      ref={ref}
      type="button"
      className={cn(
        "inline-flex min-h-10 min-w-0 items-center justify-center gap-1.5 px-3 py-2 text-sm font-semibold transition-colors [@media(orientation:landscape)_and_(max-height:520px)]:min-h-8 [@media(orientation:landscape)_and_(max-height:520px)]:py-1",
        active ? "text-txt" : "text-muted hover:text-txt",
      )}
      onClick={() => onSelect(tab.id)}
      aria-label={tab.label}
      aria-current={active ? "true" : undefined}
      title={tab.label}
      data-testid={`wallet-tab-${tab.id}`}
      {...agentProps}
    >
      <tab.icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{tab.label}</span>
    </Button>
  );
}

function TokenRailRowImpl({
  row,
  profile,
  maxPnl,
  onHideToken,
}: {
  row: TokenRow;
  profile: WalletTradingProfileResponse | null;
  maxPnl: number;
  onHideToken: (row: TokenRow) => void;
}) {
  const slug = tokenAgentSlug(row);
  const { ref: hideRef, agentProps: hideAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `token-${slug}-hide`,
      role: "button",
      label: `Hide ${row.symbol}`,
      group: "token-list",
      description: `Hide the ${row.symbol} token from the list`,
    });
  return (
    <div
      className="group flex min-w-0 items-center gap-3 px-2 py-2 transition-colors hover:bg-bg-muted/20"
      data-testid={`wallet-token-row-${slug}`}
    >
      <TokenIdentityIcon row={row} size={46} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-txt">
          {row.symbol}
        </div>
        <div className="truncate text-xs-tight text-muted">
          {formatBalance(row.balance)} {row.symbol}
        </div>
        <div className="mt-1">
          <TokenPerformance row={row} profile={profile} maxAbsPnl={maxPnl} />
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <div className="font-mono text-sm font-semibold text-txt">
          {formatUsd(row.valueUsd)}
        </div>
        <div className="flex gap-1 opacity-70 transition-opacity group-hover:opacity-100">
          <Button
            unstyled
            ref={hideRef}
            type="button"
            className="flex h-11 w-11 items-center justify-center rounded-sm text-muted transition-colors hover:text-danger"
            onClick={() => onHideToken(row)}
            aria-label={`Hide ${row.symbol}`}
            title={`Hide ${row.symbol}`}
            data-testid={`wallet-token-hide-${slug}`}
            {...hideAgentProps}
          >
            <EyeOff className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// The 20s balance poll replaces row objects wholesale, so default shallow
// compare always sees a new `row` reference. Compare only the fields that drive
// rendering (identity, displayed balance/value, performance inputs) so the row
// re-renders only when its visible content actually changes.
const TokenRailRow = memo(
  TokenRailRowImpl,
  (prev, next) =>
    prev.onHideToken === next.onHideToken &&
    prev.maxPnl === next.maxPnl &&
    prev.profile === next.profile &&
    prev.row.chain === next.row.chain &&
    prev.row.symbol === next.row.symbol &&
    prev.row.name === next.row.name &&
    prev.row.contractAddress === next.row.contractAddress &&
    prev.row.logoUrl === next.row.logoUrl &&
    prev.row.balance === next.row.balance &&
    prev.row.valueUsd === next.row.valueUsd &&
    prev.row.balanceRaw === next.row.balanceRaw &&
    prev.row.isNative === next.row.isNative,
);

function RailNftList({ nfts }: { nfts: NftItem[] }) {
  if (nfts.length === 0) {
    return (
      <ChatEmptyStateWithRecommendations
        icon={ImageIcon}
        className="min-h-[13rem]"
        recommendations={[
          "Find NFTs worth collecting",
          "Show trending mints this week",
        ]}
      />
    );
  }

  return (
    <div className="space-y-1">
      {nfts.slice(0, 20).map((nft) => (
        <div
          key={`${nft.chain}:${nft.collectionName}:${nft.name}:${nft.imageUrl}`}
          className="flex min-w-0 items-center gap-3 px-2 py-2 transition-colors hover:bg-bg-muted/20"
        >
          {nft.imageUrl ? (
            <img
              src={nft.imageUrl}
              alt={nft.name}
              className="h-11 w-11 shrink-0 object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-11 w-11 shrink-0 items-center justify-center">
              <ImageIcon className="h-4 w-4 text-muted" />
            </div>
          )}
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-txt">
              {nft.name}
            </div>
            <div className="truncate text-xs-tight text-muted">
              {nft.collectionName}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function RailPositionList({
  positions,
}: {
  positions: InventoryPositionAsset[];
}) {
  if (positions.length === 0) {
    return (
      <ChatEmptyStateWithRecommendations
        icon={Layers3}
        className="min-h-[13rem]"
        recommendations={[
          "Show me my DeFi positions",
          "Where can I stake my tokens?",
          "Find the best yield for my USDC",
        ]}
      />
    );
  }

  return (
    <div className="space-y-1">
      {positions.map((position) => (
        <div
          key={position.id}
          className="flex min-w-0 items-center gap-3 px-2 py-2 transition-colors hover:bg-bg-muted/20"
        >
          {position.imageUrl ? (
            <img
              src={position.imageUrl}
              alt={position.label}
              className="h-11 w-11 shrink-0 object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-11 w-11 shrink-0 items-center justify-center">
              <Layers3 className="h-4 w-4 text-muted" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-txt">
              {position.label}
            </div>
            <div className="truncate text-xs-tight text-muted">
              {position.detail}
            </div>
          </div>
          {position.valueUsd !== null && position.valueUsd > 0 ? (
            <div className="shrink-0 font-mono text-sm font-semibold text-txt">
              {formatUsd(position.valueUsd)}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function WalletHoldingsSection({
  rows,
  nfts,
  positions,
  addresses,
  hiddenTokenIds,
  walletConfig,
  profile,
  onHideToken,
  onOpenRpcSettings,
  walletEnabled,
  onEnableWallet,
}: {
  rows: TokenRow[];
  nfts: NftItem[];
  positions: InventoryPositionAsset[];
  addresses: { evmAddress: string | null; solanaAddress: string | null };
  hiddenTokenIds: Set<string>;
  walletConfig: WalletConfigStatus | null;
  profile: WalletTradingProfileResponse | null;
  onHideToken: (row: TokenRow) => void;
  onOpenRpcSettings: () => void;
  walletEnabled: boolean | null;
  onEnableWallet: () => void;
}) {
  const [activeTab, setActiveTab] = useState<WalletRailTab>("tokens");
  const visibleRows = useMemo(
    () =>
      rows.filter((row) => {
        if (hiddenTokenIds.has(tokenId(row))) return false;
        return tokenHasInventory(row);
      }),
    [hiddenTokenIds, rows],
  );
  const totalUsd = useMemo(
    () => visibleRows.reduce((sum, row) => sum + row.valueUsd, 0),
    [visibleRows],
  );
  const maxPnl = useMemo(
    () => maxAbsTokenPnl(visibleRows, profile),
    [visibleRows, profile],
  );
  const tabs: Array<{
    id: WalletRailTab;
    label: string;
    icon: LucideIcon;
  }> = [
    { id: "tokens", label: "Tokens", icon: Wallet },
    { id: "defi", label: "DeFi", icon: Layers3 },
    { id: "nfts", label: "NFTs", icon: ImageIcon },
  ];
  const { ref: enableWalletRef, agentProps: enableWalletAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "action-enable-wallet",
      role: "button",
      label: "Enable wallet",
      group: "wallet-actions",
      description: "Turn on the wallet to load balances and trading data",
    });

  return (
    <section
      data-testid="wallets-sidebar"
      className="px-3 py-2 md:px-4 [@media(orientation:landscape)_and_(max-height:520px)]:py-1"
    >
      <WalletRailAccount
        addresses={addresses}
        portfolioValueUsd={totalUsd}
        walletConfig={walletConfig}
        onOpenSettings={onOpenRpcSettings}
      />
      <div className="mt-3 space-y-3 [@media(orientation:landscape)_and_(max-height:520px)]:mt-2 [@media(orientation:landscape)_and_(max-height:520px)]:space-y-2">
        {visibleRows.length > 0 ? (
          <AssetAllocationStrip rows={visibleRows} compact />
        ) : null}

        {walletEnabled === false ? (
          <Button
            ref={enableWalletRef}
            className="w-full"
            onClick={onEnableWallet}
            {...enableWalletAgentProps}
          >
            Enable wallet
          </Button>
        ) : null}

        <div className="grid min-w-0 grid-cols-3 gap-1">
          {tabs.map((tab) => (
            <WalletRailTabButton
              key={tab.id}
              tab={tab}
              active={activeTab === tab.id}
              onSelect={setActiveTab}
            />
          ))}
        </div>

        <div className="space-y-1">
          {activeTab === "tokens" ? (
            visibleRows.length === 0 ? (
              <ChatEmptyStateWithRecommendations
                icon={Wallet}
                className="min-h-[13rem]"
                recommendations={[
                  "How do I fund my wallet?",
                  "Buy ETH with my card",
                  "Bridge USDC to Base",
                ]}
              />
            ) : (
              visibleRows.map((row) => (
                <TokenRailRow
                  key={tokenId(row)}
                  row={row}
                  profile={profile}
                  maxPnl={maxPnl}
                  onHideToken={onHideToken}
                />
              ))
            )
          ) : activeTab === "defi" ? (
            <RailPositionList positions={positions} />
          ) : activeTab === "nfts" ? (
            <RailNftList nfts={nfts} />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function DashboardWindowButton({
  window,
  active,
  onSelect,
}: {
  window: DashboardWindow;
  active: boolean;
  onSelect: (window: DashboardWindow) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `pnl-window-${window}`,
    role: "tab",
    label: `P&L window ${window}`,
    group: "pnl-window",
    status: active ? "active" : "inactive",
    description: `Show profit and loss over the ${window} window`,
  });
  return (
    <Button
      unstyled
      ref={ref}
      type="button"
      style={{ minWidth: 44 }}
      className={cn(
        "min-h-11 rounded-sm px-3 py-2 text-xs font-medium transition-colors",
        active ? "text-accent" : "text-muted hover:text-txt",
      )}
      onClick={() => onSelect(window)}
      aria-current={active ? "true" : undefined}
      {...agentProps}
    >
      {window}
    </Button>
  );
}

function DashboardSection({
  action,
  children,
}: {
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4">
      {action ? <div className="flex justify-end">{action}</div> : null}
      {children}
    </section>
  );
}

function ActivityLog({
  profile,
  events,
}: {
  profile: WalletTradingProfileResponse | null;
  events: ActivityEvent[];
}) {
  const entries = useMemo(
    () => walletTimelineEntries({ profile, events }),
    [events, profile],
  );

  if (entries.length === 0) {
    return (
      <ChatEmptyStateWithRecommendations
        icon={Activity}
        className="min-h-[8rem]"
        recommendations={[
          "Show my recent transactions",
          "Swap 0.1 ETH for USDC",
          "What did my agent do today?",
        ]}
      />
    );
  }

  return (
    <div className="space-y-2">
      {entries.map((entry) => {
        const toneClass =
          entry.tone === "ok"
            ? "bg-ok/10 text-ok"
            : entry.tone === "warn"
              ? "bg-warn/10 text-warn"
              : entry.tone === "danger"
                ? "bg-danger/10 text-danger"
                : "bg-bg/55 text-muted";
        const body = (
          <div className="flex min-w-0 items-center gap-3 px-2 py-2 text-sm transition-colors hover:bg-bg-muted/20">
            <span
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center",
                toneClass,
              )}
            >
              <entry.icon className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-txt">
                {entry.title}
              </span>
              {entry.detail ? (
                <span className="block truncate text-xs-tight text-muted">
                  {entry.detail}
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-[0.68rem] font-medium text-muted">
              {formatRelativeTimestamp(entry.timestamp)}
            </span>
          </div>
        );

        if (entry.href) {
          return (
            <a
              key={entry.id}
              href={entry.href}
              target="_blank"
              rel="noreferrer"
            >
              {body}
            </a>
          );
        }

        return <div key={entry.id}>{body}</div>;
      })}
    </div>
  );
}

function NftPreview({ nfts }: { nfts: NftItem[] }) {
  const visible = nfts.slice(0, 6);

  if (visible.length === 0) {
    return (
      <ChatEmptyStateWithRecommendations
        icon={ImageIcon}
        className="min-h-[8rem]"
        recommendations={[
          "What NFT collections are trending?",
          "Show floor prices for a collection",
          "Find NFTs on Base",
        ]}
      />
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      {visible.map((nft) => (
        <div
          key={`${nft.chain}:${nft.collectionName}:${nft.name}:${nft.imageUrl}`}
          className="overflow-hidden"
        >
          {nft.imageUrl ? (
            <img
              src={nft.imageUrl}
              alt={nft.name}
              className="aspect-square w-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex aspect-square items-center justify-center">
              <ImageIcon className="h-5 w-5 text-muted" />
            </div>
          )}
          <div className="min-w-0 p-2">
            <div className="truncate text-xs font-medium text-txt">
              {nft.name}
            </div>
            <div className="truncate text-[0.68rem] text-muted">
              {nft.collectionName}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function LpPositionsPanel({
  positions,
}: {
  positions: InventoryPositionAsset[];
}) {
  if (positions.length === 0) {
    return (
      <ChatEmptyStateWithRecommendations
        icon={Layers3}
        className="min-h-[8rem]"
        recommendations={[
          "How do I provide liquidity?",
          "Explain impermanent loss",
          "Show me top liquidity pools",
        ]}
      />
    );
  }

  return (
    <div className="grid gap-1">
      {positions.map((position) => (
        <div
          key={position.id}
          className="flex min-w-0 items-center gap-3 px-2 py-2 transition-colors hover:bg-bg-muted/20"
        >
          {position.imageUrl ? (
            <img
              src={position.imageUrl}
              alt={position.label}
              className="h-10 w-10 shrink-0 object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center">
              {position.kind === "nft" ? (
                <ImageIcon className="h-4 w-4 text-muted" />
              ) : (
                <Layers3 className="h-4 w-4 text-muted" />
              )}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-txt">
              {position.label}
            </div>
            <div className="truncate text-xs-tight text-muted">
              {position.detail}
            </div>
          </div>
          {position.valueUsd !== null && position.valueUsd > 0 ? (
            <div className="shrink-0 font-mono text-sm font-semibold text-txt">
              {formatUsd(position.valueUsd)}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function InventoryAppView() {
  const {
    walletEnabled,
    walletAddresses,
    walletConfig,
    walletBalances,
    walletNfts,
    walletLoading,
    walletNftsLoading,
    walletError,
    loadWalletConfig,
    loadBalances,
    loadNfts,
    setState,
    setTab,
    setActionNotice,
  } = useAppSelectorShallow((s) => ({
    walletEnabled: s.walletEnabled,
    walletAddresses: s.walletAddresses,
    walletConfig: s.walletConfig,
    walletBalances: s.walletBalances,
    walletNfts: s.walletNfts,
    walletLoading: s.walletLoading,
    walletNftsLoading: s.walletNftsLoading,
    walletError: s.walletError,
    loadWalletConfig: s.loadWalletConfig,
    loadBalances: s.loadBalances,
    loadNfts: s.loadNfts,
    setState: s.setState,
    setTab: s.setTab,
    setActionNotice: s.setActionNotice,
  }));
  const { events: activityEvents } = useActivityEvents();
  const [hiddenTokenIds, setHiddenTokenIds] = useState<Set<string>>(() =>
    readHiddenTokenIds(),
  );
  const [dashboardWindow, setDashboardWindow] =
    useState<DashboardWindow>("30d");
  const [tradingProfile, setTradingProfile] =
    useState<WalletTradingProfileResponse | null>(null);
  const [tradingProfileLoading, setTradingProfileLoading] = useState(false);
  const [tradingProfileError, setTradingProfileError] = useState<string | null>(
    null,
  );
  const [marketOverview, setMarketOverview] =
    useState<WalletMarketOverviewResponse | null>(null);
  const [marketOverviewLoading, setMarketOverviewLoading] = useState(false);
  const initialLoadRef = useRef(false);
  const tradingProfileRequestRef = useRef(0);
  const marketOverviewRequestRef = useRef(0);

  const loadTradingProfile = useCallback(async () => {
    const requestId = tradingProfileRequestRef.current + 1;
    tradingProfileRequestRef.current = requestId;
    setTradingProfileLoading(true);
    setTradingProfileError(null);

    try {
      const profile = await client.getWalletTradingProfile(
        tradingProfileWindow(dashboardWindow),
      );
      if (tradingProfileRequestRef.current === requestId) {
        setTradingProfile(profile);
      }
    } catch (cause) {
      const message =
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Failed to load trading profile.";
      if (tradingProfileRequestRef.current === requestId) {
        setTradingProfile(null);
        setTradingProfileError(message);
      }
    } finally {
      if (tradingProfileRequestRef.current === requestId) {
        setTradingProfileLoading(false);
      }
    }
  }, [dashboardWindow]);

  const loadMarketOverview = useCallback(async () => {
    const requestId = marketOverviewRequestRef.current + 1;
    marketOverviewRequestRef.current = requestId;
    setMarketOverviewLoading(true);

    try {
      const overview = await client.getWalletMarketOverview();
      if (marketOverviewRequestRef.current === requestId) {
        setMarketOverview(overview);
      }
    } catch {
      // Market overview is an optional capability — when the feed is
      // unavailable the empty-wallet hero simply omits the market panels
      // rather than surfacing an error.
      if (marketOverviewRequestRef.current === requestId) {
        setMarketOverview(null);
      }
    } finally {
      if (marketOverviewRequestRef.current === requestId) {
        setMarketOverviewLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (initialLoadRef.current) return;
    initialLoadRef.current = true;
    void loadWalletConfig();
    void loadMarketOverview();
    if (walletEnabled === false) return;
    void loadBalances();
    void loadNfts();
  }, [
    loadBalances,
    loadMarketOverview,
    loadNfts,
    loadWalletConfig,
    walletEnabled,
  ]);

  useEffect(() => {
    void loadTradingProfile();
  }, [loadTradingProfile]);

  // No manual refresh control: keep balances, NFTs, trading profile, and
  // market data fresh with a quiet background poll while the view is mounted.
  useEffect(() => {
    if (walletEnabled === false) return;
    const interval = window.setInterval(() => {
      void loadWalletConfig();
      void loadBalances();
      void loadNfts();
      void loadTradingProfile();
      void loadMarketOverview();
    }, WALLET_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [
    loadBalances,
    loadMarketOverview,
    loadNfts,
    loadTradingProfile,
    loadWalletConfig,
    walletEnabled,
  ]);

  const inventoryData = useInventoryData({
    walletBalances,
    walletAddresses,
    walletConfig,
    walletNfts,
    inventorySort: "value",
    inventorySortDirection: "desc",
    inventoryChainFilters: ALL_INVENTORY_FILTERS,
  });

  const addresses = useMemo(
    () => resolveWalletAddresses({ walletAddresses, walletConfig }),
    [walletAddresses, walletConfig],
  );

  const visibleAssetRows = useMemo(
    () => inventoryData.tokenRowsAllChains.filter(tokenHasInventory),
    [inventoryData.tokenRowsAllChains],
  );
  const displayedAssetRows = useMemo(
    () => visibleAssetRows.filter((row) => !hiddenTokenIds.has(tokenId(row))),
    [hiddenTokenIds, visibleAssetRows],
  );
  const lpPositions = useMemo(
    () =>
      deriveInventoryPositionAssets({
        tokenRows: displayedAssetRows,
        nfts: inventoryData.allNfts,
      }),
    [displayedAssetRows, inventoryData.allNfts],
  );

  const pnlValue = parseAmount(tradingProfile?.summary.realizedPnlBnb);
  const showTradePnl = hasClosedTradePnl(tradingProfile);
  const hasWalletTimeline =
    activityEvents.length > 0 || (tradingProfile?.recentSwaps.length ?? 0) > 0;
  const showMarketPulseHero =
    walletEnabled === false ||
    (!walletLoading &&
      !walletNftsLoading &&
      !tradingProfileLoading &&
      displayedAssetRows.length === 0 &&
      lpPositions.length === 0 &&
      inventoryData.allNfts.length === 0 &&
      !showTradePnl &&
      !hasWalletTimeline);

  const handleHideToken = useCallback(
    (row: TokenRow) => {
      const next = new Set(hiddenTokenIds);
      next.add(tokenId(row));
      setHiddenTokenIds(next);
      writeHiddenTokenIds(next);
      setActionNotice(`${row.symbol} hidden from this wallet view.`);
    },
    [hiddenTokenIds, setActionNotice],
  );

  const handleOpenRpcSettings = useCallback(() => {
    setTab("settings");
    if (typeof window !== "undefined") {
      window.location.hash = "wallet-rpc";
    }
  }, [setTab]);

  const handleEnableWallet = useCallback(() => {
    setState("walletEnabled", true);
    void loadWalletConfig();
    void loadBalances();
    void loadNfts();
  }, [loadBalances, loadNfts, loadWalletConfig, setState]);

  return (
    <main
      data-testid="wallet-shell"
      className="h-full min-h-0 w-full overflow-y-auto bg-bg"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-5 pt-6 pb-12">
        {walletError ? (
          <div className="px-1 py-2 text-sm text-danger">{walletError}</div>
        ) : null}

        <WalletHoldingsSection
          rows={visibleAssetRows}
          nfts={inventoryData.allNfts}
          positions={lpPositions}
          addresses={addresses}
          hiddenTokenIds={hiddenTokenIds}
          walletConfig={walletConfig}
          profile={tradingProfile}
          onHideToken={handleHideToken}
          onOpenRpcSettings={handleOpenRpcSettings}
          walletEnabled={walletEnabled}
          onEnableWallet={handleEnableWallet}
        />

        {showMarketPulseHero ? (
          <MarketPulseHero
            overview={marketOverview}
            loading={marketOverviewLoading}
            hasKeys={
              addresses.evmAddress !== null || addresses.solanaAddress !== null
            }
            onConfigureKeys={handleOpenRpcSettings}
          />
        ) : null}

        {!showMarketPulseHero ? (
          <div className="flex flex-col gap-8">
            <DashboardSection
              action={
                <div className="flex gap-1">
                  {DASHBOARD_WINDOWS.map((window) => (
                    <DashboardWindowButton
                      key={window}
                      window={window}
                      active={dashboardWindow === window}
                      onSelect={setDashboardWindow}
                    />
                  ))}
                </div>
              }
            >
              {(showTradePnl && pnlValue !== null) ||
              displayedAssetRows.length > 0 ? (
                <div className="mb-4 flex flex-wrap items-center gap-3">
                  {showTradePnl && pnlValue !== null ? (
                    <SummaryChip
                      icon={pnlValue >= 0 ? TrendingUp : TrendingDown}
                      value={`${pnlValue > 0 ? "+" : ""}${formatBnb(tradingProfile?.summary.realizedPnlBnb)}`}
                      tone={pnlValue >= 0 ? "gain" : "loss"}
                      title="Realized P&L"
                    />
                  ) : null}
                  {displayedAssetRows.length > 0 ? (
                    <div className="min-w-0 flex-1">
                      <AssetAllocationStrip rows={displayedAssetRows} compact />
                    </div>
                  ) : null}
                </div>
              ) : null}
              <PnlChart profile={tradingProfile} />
              {tradingProfileError ? (
                <div className="mt-3 text-xs-tight text-danger">
                  {tradingProfileError}
                </div>
              ) : null}
            </DashboardSection>

            <DashboardSection>
              <ActivityLog profile={tradingProfile} events={activityEvents} />
            </DashboardSection>

            <DashboardSection>
              <PortfolioMoversPanel
                rows={displayedAssetRows}
                profile={tradingProfile}
                marketOverview={marketOverview}
              />
            </DashboardSection>

            <DashboardSection>
              <LpPositionsPanel positions={lpPositions} />
            </DashboardSection>

            <DashboardSection>
              <NftPreview nfts={inventoryData.allNfts} />
            </DashboardSection>
          </div>
        ) : null}
      </div>
    </main>
  );
}
