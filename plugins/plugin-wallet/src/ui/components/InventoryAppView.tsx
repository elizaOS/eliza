/**
 * InventoryAppView — the full-screen wallet dashboard.
 *
 * It owns the grouped wallet surface: recognized EVM and Solana holdings
 * (tokens / DeFi / NFTs), activity, and market context backed by the app store
 * and market overview feed.
 *
 * It is no longer registered as a separate app/nav tab. The unified
 * {@link InventoryView} renders it as the real-DOM child of its `Escape` hatch.
 * This is the DOM-only dashboard reached only through that wrapper.
 */
import type {
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletMarketMover,
  WalletMarketOverviewResponse,
  WalletMarketOverviewSource,
  WalletNftsResponse,
  WalletTradingProfileResponse,
} from "@elizaos/shared";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
} from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { client, isApiError } from "@elizaos/ui/api";
import { shellLocalStorage } from "@elizaos/ui/bridge";
import { ListSkeleton } from "@elizaos/ui/components";
import { PagePanel } from "@elizaos/ui/components/composites/page-panel";
import {
  type ActivityEvent,
  getActiveAgentAuthority,
  useActiveAgentAuthority,
  useActivityEvents,
} from "@elizaos/ui/hooks";
import type {
  InventoryChainFilters,
  WalletResourceStatus,
} from "@elizaos/ui/state";
import { useAppSelectorShallow } from "@elizaos/ui/state";
import { cn, copyTextToClipboard } from "@elizaos/ui/utils";
import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
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
import * as React from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveWalletAddresses } from "../InventoryView.helpers";
import { getChainConfig, getNativeLogoUrl } from "../inventory/chainConfig.ts";
import {
  formatBalance,
  type NftItem,
  type TokenRow,
} from "../inventory/constants.ts";
import { TokenLogo } from "../inventory/TokenLogo.tsx";
import { useInventoryData } from "../inventory/useInventoryData.ts";

// The app's workspace-source build can emit classic JSX for plugin modules.
// Keep the namespace live even though the standalone view uses the automatic runtime.
void React;

type WalletRailTab = "tokens" | "defi" | "nfts";
type WalletInsightTab = "activity" | "markets";

const ALL_INVENTORY_FILTERS: InventoryChainFilters = {
  ethereum: true,
  base: true,
  bsc: true,
  avax: true,
  solana: true,
};
const WALLET_IDENTITY_CHAINS = [
  { chain: "ethereum", label: "EVM", id: "evm" },
  { chain: "solana", label: "Solana", id: "solana" },
] as const;

function isSupportedWalletAssetChain(chain: string): boolean {
  const config = getChainConfig(chain);
  return config?.isEvm === true || config?.chainKey === "solana";
}

function supportedWalletNfts(walletNfts: WalletNftsResponse | null): NftItem[] {
  if (!walletNfts) return [];

  const items: NftItem[] = walletNfts.evm.flatMap((chainData) =>
    chainData.nfts.map((nft) => ({
      chain: chainData.chain,
      name: nft.name,
      imageUrl: nft.imageUrl,
      collectionName: nft.collectionName || nft.tokenType,
    })),
  );

  if (walletNfts.solana) {
    items.push(
      ...walletNfts.solana.nfts.map((nft) => ({
        chain: "Solana",
        name: nft.name,
        imageUrl: nft.imageUrl,
        collectionName: nft.collectionName,
      })),
    );
  }

  return items.filter((nft) => isSupportedWalletAssetChain(nft.chain));
}

const HIDDEN_TOKEN_IDS_KEY = "eliza:wallet:hidden-token-ids:v1";
const WALLET_REFRESH_INTERVAL_MS = 20_000;
type OptionalCapabilityState = "unknown" | "supported" | "unavailable";
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

/**
 * Calm neutral empty state (#13592): a bare muted glyph over one short line of
 * plain-fact copy. No suggestion chips, no marketing pitch, no setup CTA — an
 * empty panel states what is empty and stays quiet.
 */
function CalmEmptyState({
  icon: Icon,
  label,
  className,
}: {
  icon: LucideIcon;
  label: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-4 py-8 text-center",
        className,
      )}
    >
      <Icon className="size-5 text-muted" aria-hidden />
      <p className="text-sm text-muted">{label}</p>
    </div>
  );
}

/**
 * error-policy:J4 — synthesize a fully-unavailable market overview from a fetch
 * failure. Every source is marked `available:false` and carries the error, so
 * the dashboard's market panels render `MarketDataUnavailable` (a named,
 * distinguishable state) rather than a silent null that reads as "empty".
 */
function marketOverviewUnavailable(
  error: string,
): WalletMarketOverviewResponse {
  const source = (
    providerId: WalletMarketOverviewSource["providerId"],
    providerName: string,
    providerUrl: string,
  ): WalletMarketOverviewSource => ({
    providerId,
    providerName,
    providerUrl,
    available: false,
    stale: false,
    error,
  });
  return {
    generatedAt: new Date().toISOString(),
    cacheTtlSeconds: 0,
    stale: false,
    sources: {
      prices: source("coingecko", "CoinGecko", "https://www.coingecko.com"),
      movers: source("coingecko", "CoinGecko", "https://www.coingecko.com"),
      predictions: source("polymarket", "Polymarket", "https://polymarket.com"),
    },
    prices: [],
    movers: [],
    predictions: [],
  };
}

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
  // HIDDEN_TOKEN_IDS_KEY is under the shell-reserved `eliza:` namespace, so a
  // raw localStorage write is denied by the surface-realm raw-global guard
  // (SurfaceRealmDeniedError) while this view holds the foreground scope, and a
  // local try/catch would swallow it into silent persistence loss. Route
  // reserved-key writes through the shell-privileged channel — the sanctioned
  // path for every reserved-key writer (surface-realm-broker.ts /
  // scan-reserved-storage-writers.mjs).
  try {
    shellLocalStorage.setItem(HIDDEN_TOKEN_IDS_KEY, JSON.stringify([...next]));
  } catch {
    // error-policy:J4 the hide-set is best-effort view preference; a genuine
    // storage-unavailable environment (quota/private mode) degrades to an
    // unpersisted hide for this session rather than throwing out of the click
    // handler.
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

function isOptionalCapabilityUnavailable(
  cause: unknown,
  code: string,
): boolean {
  return (
    isApiError(cause) &&
    (cause.status === 404 || cause.status === 501 || cause.code === code)
  );
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

function tokenHasInventory(row: TokenRow): boolean {
  return row.balanceRaw > 0 || row.valueUsd > 0;
}

function tokenValueAvailable(
  row: TokenRow,
  balances: WalletBalancesResponse | null,
): boolean {
  if (!row.isNative || row.balanceRaw === 0) return true;
  if (row.chain.trim().toLowerCase() === "solana") {
    return balances?.solana !== null;
  }
  const chain = balances?.evm?.chains.find(
    (candidate) =>
      candidate.chain.trim().toLowerCase() === row.chain.trim().toLowerCase(),
  );
  return chain?.error === null;
}

function assetAllocationRows(rows: TokenRow[]): TokenRow[] {
  return rows
    .filter((row) => Number.isFinite(row.valueUsd) && row.valueUsd > 0)
    .sort(
      (left, right) =>
        (Number.isFinite(right.valueUsd) ? right.valueUsd : 0) -
        (Number.isFinite(left.valueUsd) ? left.valueUsd : 0),
    )
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
}: {
  row: TokenRow;
  profile: WalletTradingProfileResponse | null;
}) {
  const breakdown = tokenBreakdownForRow(row, profile);

  if (!breakdown) {
    return null;
  }

  const pnl = parseAmount(breakdown.realizedPnlBnb);
  if (pnl === null) return null;

  const TrendIcon = pnl >= 0 ? TrendingUp : TrendingDown;
  const tone = pnl === 0 ? "text-muted" : pnl > 0 ? "text-txt" : "text-danger";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[0.68rem] font-medium tabular-nums",
        tone,
      )}
      title={`Realized P&L: ${formatBnb(breakdown.realizedPnlBnb)}`}
    >
      <TrendIcon className="size-3" aria-hidden />
      <span>
        {pnl > 0 ? "+" : ""}
        {formatBnb(breakdown.realizedPnlBnb)}
      </span>
      <span className="sr-only">Realized profit and loss</span>
    </span>
  );
}

function ChainLogoBadge({
  chain,
  size = 18,
  className,
  testId,
  label = chain,
}: {
  chain: string;
  size?: number;
  className?: string;
  testId?: string;
  label?: string;
}) {
  const [errored, setErrored] = useState(false);
  const logoUrl = errored ? null : getNativeLogoUrl(chain);
  const fallbackLabel = (getChainConfig(chain)?.chainKey ?? chain)
    .slice(0, 2)
    .toUpperCase();

  return (
    <span
      className={cn("inline-flex shrink-0 ring-2 ring-bg", className)}
      style={{ width: size, height: size }}
    >
      <Avatar
        presentation="walletLogo"
        size={size}
        title={label}
        role="img"
        aria-label={label}
        data-testid={testId}
      >
        {logoUrl ? (
          <AvatarImage
            src={logoUrl}
            alt=""
            className="object-cover"
            onError={() => setErrored(true)}
          />
        ) : null}
        <AvatarFallback className="font-mono text-[0.45rem] font-semibold uppercase tracking-tight text-muted">
          {fallbackLabel}
        </AvatarFallback>
      </Avatar>
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
      <Badge
        asChild
        variant="chainDot"
        tone="muted"
        className={cn("flex overflow-hidden", compact ? "h-2.5" : "h-2")}
      >
        <div>
          {allocationRows.map((row, index) => (
            <Badge
              asChild
              variant="chainDot"
              tone={index < 3 ? "accent" : "muted"}
              key={tokenId(row)}
              className="h-full"
            >
              <span
                style={{ width: `${(row.valueUsd / total) * 100}%` }}
                title={`${row.symbol}: ${formatUsd(row.valueUsd)}`}
              />
            </Badge>
          ))}
        </div>
      </Badge>
      {compact ? (
        <div className="flex flex-wrap gap-2">
          {allocationRows.slice(0, 3).map((row, index) => (
            <div
              key={tokenId(row)}
              className="inline-flex items-center gap-1.5 text-[0.68rem] font-medium text-txt"
            >
              <Badge
                asChild
                variant="chainDot"
                tone={index < 3 ? "accent" : "muted"}
                className="size-1.5"
              >
                <span />
              </Badge>
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
          <TrendingUp className="size-3.5 text-muted" />
        ) : (
          <TrendingDown className="size-3.5 text-danger" />
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
  loading,
}: {
  rows: TokenRow[];
  profile: WalletTradingProfileResponse | null;
  marketOverview: WalletMarketOverviewResponse | null;
  loading: boolean;
}) {
  const movers = useMemo(() => portfolioMovers(rows, profile), [rows, profile]);
  const gainers = useMemo(
    () =>
      movers
        .filter(
          (mover) =>
            Number.isFinite(mover.realizedPnlBnb) && mover.realizedPnlBnb > 0,
        )
        .sort(
          (left, right) =>
            (Number.isFinite(right.realizedPnlBnb) ? right.realizedPnlBnb : 0) -
            (Number.isFinite(left.realizedPnlBnb) ? left.realizedPnlBnb : 0),
        )
        .slice(0, 3),
    [movers],
  );
  const losers = useMemo(
    () =>
      movers
        .filter(
          (mover) =>
            Number.isFinite(mover.realizedPnlBnb) && mover.realizedPnlBnb < 0,
        )
        .sort(
          (left, right) =>
            (Number.isFinite(left.realizedPnlBnb) ? left.realizedPnlBnb : 0) -
            (Number.isFinite(right.realizedPnlBnb) ? right.realizedPnlBnb : 0),
        )
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
    if (loading && marketOverview === null) {
      return (
        <div role="status" aria-label="Loading market movers">
          <ListSkeleton rows={3} />
        </div>
      );
    }

    if (marketOverview?.movers.length) {
      return (
        <MarketMoverList
          movers={marketOverview.movers}
          source={marketOverview.sources.movers}
        />
      );
    }

    // error-policy:J4 — distinguish "feed unavailable" from "genuinely no
    // movers": a failed overview marks its movers source unavailable, so
    // surface that named state instead of the calm empty line.
    const moversSource = marketOverview?.sources.movers;
    if (moversSource && !moversSource.available) {
      return <MarketDataUnavailable title="Top movers" />;
    }

    return (
      <CalmEmptyState
        icon={TrendingUp}
        label="No portfolio movers yet."
        className="min-h-[8rem]"
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
        className="size-11 shrink-0 rounded-full bg-surface object-cover"
        loading="lazy"
      />
    );
  }

  return (
    <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-surface text-sm font-semibold text-txt">
      {label.slice(0, 1).toUpperCase()}
    </div>
  );
}

function MarketDataUnavailable({ title }: { title: string }) {
  return (
    <div
      className="flex min-h-32 flex-col items-center justify-center gap-2 px-4 py-6 text-center"
      title={`${title} unavailable`}
    >
      <AlertTriangle className="size-5 text-muted" aria-hidden />
      <div className="text-sm font-medium text-txt">
        Market data unavailable
      </div>
      <div className="max-w-xs text-xs-tight text-muted">
        Live movers will return automatically when the feed reconnects.
      </div>
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
    return <MarketDataUnavailable title="Top movers" />;
  }

  if (movers.length === 0) {
    return (
      <CalmEmptyState
        icon={TrendingUp}
        label="No market movers right now."
        className="min-h-[8rem]"
      />
    );
  }

  return (
    <div className="divide-y divide-border/60">
      {movers.map((mover) => {
        const isPositive = mover.change24hPct >= 0;
        return (
          <div key={mover.id} className="flex min-w-0 items-center gap-3 p-3">
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

// The empty wallet is calm (#13592): one familiar glyph, neutral copy, and no
// competing setup choices. The functional Enable-wallet control lives in the
// holdings section; wiring keys/RPC remains reachable from RPC settings.
function WalletEmptyHero() {
  return (
    <div className="flex min-h-36 flex-col items-center justify-center gap-3 px-5 py-6 text-center">
      <span
        className="flex size-11 items-center justify-center rounded-sm bg-accent-subtle text-accent"
        role="img"
        aria-label="Empty wallet"
      >
        <Wallet className="size-5" aria-hidden />
      </span>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-txt">Your wallet is empty.</p>
        <p className="text-xs-tight text-muted">
          Assets will appear here when a supported wallet has a balance.
        </p>
      </div>
    </div>
  );
}

function WalletBalancesUnavailableInline({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      data-testid="wallet-balances-unavailable"
      className="flex min-h-32 items-center justify-between gap-4 px-4 py-5"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface text-muted">
          <AlertTriangle className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-txt">
            Balances are unavailable
          </p>
          <p className="mt-1 text-xs-tight text-muted">
            Your wallet controls are still available.
          </p>
        </div>
      </div>
      <Button variant="outline" size="touch" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function WalletBalancesLoadingState() {
  return (
    <div
      role="status"
      aria-label="Loading wallet balances"
      data-testid="wallet-balances-loading"
      className="flex min-h-40 w-full items-center rounded-xl border border-border bg-card px-4 py-5"
    >
      <div className="w-full">
        <ListSkeleton rows={2} rowClassName="h-11" />
      </div>
    </div>
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
    .sort((left, right) => {
      const rightTime =
        typeof right.timestamp === "number" && Number.isFinite(right.timestamp)
          ? right.timestamp
          : 0;
      const leftTime =
        typeof left.timestamp === "number" && Number.isFinite(left.timestamp)
          ? left.timestamp
          : 0;
      return rightTime - leftTime || left.id.localeCompare(right.id);
    })
    .slice(0, 18);
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
  const copyResetTimeoutRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }
    },
    [],
  );

  const handleCopy = useCallback(() => {
    if (!address) return;
    void copyTextToClipboard(address).then(
      () => {
        if (copyResetTimeoutRef.current !== null) {
          window.clearTimeout(copyResetTimeoutRef.current);
        }
        setCopied(true);
        copyResetTimeoutRef.current = window.setTimeout(() => {
          setCopied(false);
          copyResetTimeoutRef.current = null;
        }, 1200);
      },
      () => {
        // error-policy:J4 clipboard denial (permissions policy, headless
        // harness) is an expected per-call failure: the control stays in its
        // visible un-copied state instead of flashing a false "Copied".
      },
    );
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
      variant="ghost"
      size="default"
      align="start"
      ref={ref}
      type="button"
      className="group min-w-0"
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
          <CheckCircle2 className="size-3.5 shrink-0 text-accent" />
        ) : (
          <Copy className="size-3.5 shrink-0 text-muted transition-colors group-hover:text-txt" />
        )
      ) : (
        <AlertTriangle className="size-3.5 shrink-0 text-warn" />
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
  const StatusIcon = ready ? CheckCircle2 : AlertTriangle;
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[0.68rem] font-medium text-muted"
      title={`${label} ${ready ? "RPC ready" : "needs RPC"}`}
    >
      <StatusIcon
        className={cn("size-3.5", ready ? "text-muted-strong" : "text-warn")}
        aria-hidden
      />
      {label}
    </span>
  );
}

function WalletIdentityCluster() {
  return (
    <span className="flex shrink-0 -space-x-1.5">
      {WALLET_IDENTITY_CHAINS.map((identity) => (
        <ChainLogoBadge
          key={identity.id}
          chain={identity.chain}
          label={identity.label}
          size={18}
          className="ring-1 ring-bg"
          testId={`wallet-identity-chip-${identity.id}`}
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
        chains={["ethereum"]}
        emptyLabel="EVM"
        label="EVM"
        agentId="account-copy-evm-address"
        agentLabel="EVM address"
      />
      <WalletRailAddress
        address={addresses.solanaAddress}
        chains={["solana"]}
        emptyLabel="Solana"
        label="Solana"
        agentId="account-copy-solana-address"
        agentLabel="Solana address"
      />
    </div>
  );
}

function WalletProviderStatus({
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
        "inline-flex size-5 items-center justify-center",
        allReady ? "text-muted-strong" : "text-warn",
      )}
      aria-hidden
    >
      {allReady ? (
        <CheckCircle2 className="size-3.5" />
      ) : (
        <AlertTriangle className="size-3.5" />
      )}
    </span>
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
    label: "Network settings",
    group: "wallet-account",
    description: `Open network settings for EVM (${evmProvider}) and Solana (${solanaProvider})`,
  });

  return (
    <Button
      variant="ghost"
      size="sm"
      ref={ref}
      type="button"
      onClick={onOpenSettings}
      title={`RPC providers: EVM ${evmProvider}, Solana ${solanaProvider}`}
      aria-label="Open network settings"
      {...agentProps}
    >
      <WalletProviderStatus walletConfig={walletConfig} />
      Networks
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
  portfolioValueUsd: number | null;
  walletConfig: WalletConfigStatus | null;
  onOpenSettings: () => void;
}) {
  const evmReady = Boolean(walletConfig?.evmBalanceReady);
  const solanaReady = Boolean(walletConfig?.solanaBalanceReady);
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xs-tight font-medium text-muted">
            Portfolio balance
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="font-mono text-3xl font-semibold leading-none tracking-tight tabular-nums text-txt">
              {portfolioValueUsd === null ? "—" : formatUsd(portfolioValueUsd)}
            </div>
            <WalletIdentityCluster />
          </div>
          <div className="mt-2 flex flex-wrap gap-3">
            <WalletConnectionChip label="EVM" ready={evmReady} />
            <WalletConnectionChip label="Solana" ready={solanaReady} />
          </div>
        </div>
        <WalletRailRpcButton
          walletConfig={walletConfig}
          onOpenSettings={onOpenSettings}
        />
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
      variant="selection"
      size="default"
      ref={ref}
      type="button"
      className="min-w-0"
      data-state={active ? "on" : "off"}
      onClick={() => onSelect(tab.id)}
      aria-label={tab.label}
      role="tab"
      aria-selected={active}
      id={`wallet-asset-tab-${tab.id}`}
      aria-controls={`wallet-asset-panel-${tab.id}`}
      title={tab.label}
      data-testid={`wallet-tab-${tab.id}`}
      {...agentProps}
    >
      <tab.icon className="size-3.5 shrink-0" />
      <span className="truncate">{tab.label}</span>
    </Button>
  );
}

function TokenRailRowImpl({
  row,
  profile,
  valueAvailable,
  onHideToken,
}: {
  row: TokenRow;
  profile: WalletTradingProfileResponse | null;
  valueAvailable: boolean;
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
      className="group flex min-h-[4.75rem] min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-bg-hover focus-within:bg-bg-hover"
      data-testid={`wallet-token-row-${slug}`}
    >
      <TokenIdentityIcon row={row} size={42} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-txt">
          {row.symbol}
        </div>
        <div className="truncate text-xs-tight text-muted">
          {formatBalance(row.balance)} {row.symbol} · {row.chain}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <div className="flex flex-col items-end gap-1">
          <div className="font-mono text-sm font-semibold text-txt">
            {valueAvailable ? formatUsd(row.valueUsd) : "—"}
          </div>
          <TokenPerformance row={row} profile={profile} />
        </div>
        <Button
          variant="ghostMuted"
          size="icon"
          ref={hideRef}
          type="button"
          className="opacity-70 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
          onClick={() => onHideToken(row)}
          aria-label={`Hide ${row.symbol}`}
          title={`Hide ${row.symbol}`}
          data-testid={`wallet-token-hide-${slug}`}
          {...hideAgentProps}
        >
          <EyeOff className="size-3.5" />
        </Button>
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
    prev.profile === next.profile &&
    prev.valueAvailable === next.valueAvailable &&
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

function RailNftList({
  nfts,
  status,
  error,
  onRetry,
}: {
  nfts: NftItem[];
  status: WalletResourceStatus;
  error: string | null;
  onRetry: () => void;
}) {
  if ((status === "idle" || status === "loading") && nfts.length === 0) {
    return (
      <div role="status" aria-label="Loading NFTs">
        <ListSkeleton rows={3} rowClassName="h-[4.75rem]" />
      </div>
    );
  }

  if (status === "unavailable" && nfts.length === 0) {
    return (
      <CalmEmptyState
        icon={ImageIcon}
        label="NFT inventory is unavailable for this wallet."
        className="min-h-[13rem]"
      />
    );
  }

  if (status === "error" && nfts.length === 0) {
    return (
      <PagePanel.Notice
        tone="danger"
        role="alert"
        className="rounded-sm bg-destructive-subtle p-3"
        actions={
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry NFTs
          </Button>
        }
      >
        {error
          ? "Couldn't refresh collectibles."
          : "Couldn't load collectibles."}
      </PagePanel.Notice>
    );
  }

  if (nfts.length === 0) {
    return (
      <CalmEmptyState
        icon={ImageIcon}
        label="No NFTs in this wallet."
        className="min-h-[13rem]"
      />
    );
  }

  return (
    <div className="divide-y divide-border/60">
      {nfts.slice(0, 20).map((nft) => (
        <div
          key={`${nft.chain}:${nft.collectionName}:${nft.name}:${nft.imageUrl}`}
          className="flex min-h-[4.75rem] min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-bg-hover"
        >
          {nft.imageUrl ? (
            <img
              src={nft.imageUrl}
              alt={nft.name}
              className="size-11 shrink-0 rounded-sm bg-surface object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex size-11 shrink-0 items-center justify-center rounded-sm bg-surface">
              <ImageIcon className="size-4 text-muted" />
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
      <CalmEmptyState
        icon={Layers3}
        label="No DeFi positions."
        className="min-h-[13rem]"
      />
    );
  }

  return (
    <div className="divide-y divide-border/60">
      {positions.map((position) => (
        <div
          key={position.id}
          className="flex min-h-[4.75rem] min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-bg-hover"
        >
          {position.imageUrl ? (
            <img
              src={position.imageUrl}
              alt={position.label}
              className="size-11 shrink-0 rounded-sm bg-surface object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex size-11 shrink-0 items-center justify-center rounded-sm bg-surface">
              <Layers3 className="size-4 text-muted" />
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
  walletBalances,
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
  loading,
  walletConfigStatus,
  balancesStatus,
  nftsStatus,
  nftsError,
  onRetryNfts,
  onRetryBalances,
  showWalletEmptyState,
  onRestoreHiddenTokens,
}: {
  rows: TokenRow[];
  walletBalances: WalletBalancesResponse | null;
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
  loading: boolean;
  walletConfigStatus: WalletResourceStatus;
  balancesStatus: WalletResourceStatus;
  nftsStatus: WalletResourceStatus;
  nftsError: string | null;
  onRetryNfts: () => void;
  onRetryBalances: () => void;
  showWalletEmptyState: boolean;
  onRestoreHiddenTokens: () => void;
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
  const hasBalanceSnapshot = balancesStatus === "ready" || rows.length > 0;
  const walletValuationAvailable = visibleRows.every((row) =>
    tokenValueAvailable(row, walletBalances),
  );
  const portfolioValueUsd =
    hasBalanceSnapshot && walletValuationAvailable ? totalUsd : null;
  const hiddenRowsCount = useMemo(
    () => rows.filter((row) => hiddenTokenIds.has(tokenId(row))).length,
    [hiddenTokenIds, rows],
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

  const hasWalletAccount = Boolean(
    addresses.evmAddress || addresses.solanaAddress,
  );
  const walletIdentityUnavailable =
    walletConfigStatus === "error" || walletConfigStatus === "unavailable";

  if (walletEnabled !== false && !hasWalletAccount) {
    return (
      <section
        data-testid="wallets-sidebar"
        aria-label="Wallet holdings"
        className="overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="flex min-h-40 items-center justify-between gap-4 p-4 sm:p-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent">
              <Wallet className="size-4.5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-txt">
                {walletIdentityUnavailable
                  ? "Wallet connection unavailable"
                  : "No wallet connected"}
              </h2>
              <p className="mt-1 text-xs-tight text-muted">
                {walletIdentityUnavailable
                  ? "We couldn't load this agent's wallet addresses."
                  : "Connect a wallet to see balances and activity."}
              </p>
            </div>
          </div>
          <WalletRailRpcButton
            walletConfig={walletConfig}
            onOpenSettings={onOpenRpcSettings}
          />
        </div>
      </section>
    );
  }

  return (
    <section
      data-testid="wallets-sidebar"
      aria-label="Wallet holdings"
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="space-y-4 p-4 sm:p-5">
        <WalletRailAccount
          addresses={addresses}
          portfolioValueUsd={portfolioValueUsd}
          walletConfig={walletConfig}
          onOpenSettings={onOpenRpcSettings}
        />
        {visibleRows.length > 0 ? (
          <AssetAllocationStrip rows={visibleRows} compact />
        ) : null}
      </div>

      {walletEnabled === false ? (
        <div className="border-t border-border/70 p-4">
          <WalletEmptyHero />
          <Button
            ref={enableWalletRef}
            className="w-full"
            onClick={onEnableWallet}
            {...enableWalletAgentProps}
          >
            Enable wallet
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2 border-t border-border/70 p-2 sm:flex-row sm:items-center">
            <div
              className="grid min-w-0 flex-1 grid-cols-3 gap-1 rounded-sm bg-surface p-1"
              role="tablist"
              aria-label="Wallet asset type"
            >
              {tabs.map((tab) => (
                <WalletRailTabButton
                  key={tab.id}
                  tab={tab}
                  active={activeTab === tab.id}
                  onSelect={setActiveTab}
                />
              ))}
            </div>
            {hiddenRowsCount > 0 ? (
              <Button
                variant="ghostMuted"
                size="compact"
                className="w-full sm:w-auto"
                onClick={onRestoreHiddenTokens}
                aria-label={`Show ${hiddenRowsCount} hidden ${hiddenRowsCount === 1 ? "token" : "tokens"}`}
              >
                Show hidden ({hiddenRowsCount})
              </Button>
            ) : null}
          </div>

          <div
            id={`wallet-asset-panel-${activeTab}`}
            role="tabpanel"
            aria-labelledby={`wallet-asset-tab-${activeTab}`}
            className="min-h-32 border-t border-border/70"
          >
            {activeTab === "tokens" ? (
              (loading ||
                balancesStatus === "idle" ||
                balancesStatus === "loading") &&
              visibleRows.length === 0 ? (
                <div role="status" aria-label="Loading wallet assets">
                  <ListSkeleton rows={4} rowClassName="h-[4.75rem]" />
                </div>
              ) : (balancesStatus === "error" ||
                  balancesStatus === "unavailable") &&
                visibleRows.length === 0 ? (
                <WalletBalancesUnavailableInline onRetry={onRetryBalances} />
              ) : showWalletEmptyState ? (
                <WalletEmptyHero />
              ) : visibleRows.length === 0 ? (
                <CalmEmptyState
                  icon={Wallet}
                  label="No visible tokens."
                  className="min-h-[13rem]"
                />
              ) : (
                <div className="divide-y divide-border/60">
                  {visibleRows.map((row) => (
                    <TokenRailRow
                      key={tokenId(row)}
                      row={row}
                      profile={profile}
                      valueAvailable={tokenValueAvailable(row, walletBalances)}
                      onHideToken={onHideToken}
                    />
                  ))}
                </div>
              )
            ) : activeTab === "defi" ? (
              <RailPositionList positions={positions} />
            ) : activeTab === "nfts" ? (
              <RailNftList
                nfts={nfts}
                status={nftsStatus}
                error={nftsError}
                onRetry={onRetryNfts}
              />
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

function WalletInsightTabButton({
  tab,
  active,
  onSelect,
}: {
  tab: { id: WalletInsightTab; label: string };
  active: boolean;
  onSelect: (tab: WalletInsightTab) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `wallet-insight-${tab.id}`,
    role: "tab",
    label: tab.label,
    group: "wallet-insights",
    status: active ? "active" : "inactive",
    description: `Show wallet ${tab.label.toLowerCase()}`,
  });

  return (
    <Button
      ref={ref}
      variant="selection"
      size="touch"
      type="button"
      className="min-w-0"
      role="tab"
      id={`wallet-insight-tab-${tab.id}`}
      aria-controls={`wallet-insight-panel-${tab.id}`}
      aria-selected={active}
      data-state={active ? "on" : "off"}
      onClick={() => onSelect(tab.id)}
      {...agentProps}
    >
      <span className="truncate">{tab.label}</span>
    </Button>
  );
}

function WalletInsightsPanel({
  activeTab,
  onSelectTab,
  profile,
  events,
  rows,
  marketOverview,
  marketOverviewLoading,
}: {
  activeTab: WalletInsightTab;
  onSelectTab: (tab: WalletInsightTab) => void;
  profile: WalletTradingProfileResponse | null;
  events: ActivityEvent[];
  rows: TokenRow[];
  marketOverview: WalletMarketOverviewResponse | null;
  marketOverviewLoading: boolean;
}) {
  const tabs: Array<{
    id: WalletInsightTab;
    label: string;
  }> = [
    { id: "activity", label: "Activity" },
    { id: "markets", label: "Markets" },
  ];

  return (
    <section
      aria-labelledby="wallet-insights-title"
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <h2 id="wallet-insights-title" className="sr-only">
        Wallet insights
      </h2>
      <div className="p-2">
        <div
          className="grid grid-cols-2 gap-1 rounded-sm bg-surface p-1"
          role="tablist"
          aria-label="Wallet insights"
        >
          {tabs.map((tab) => (
            <WalletInsightTabButton
              key={tab.id}
              tab={tab}
              active={activeTab === tab.id}
              onSelect={onSelectTab}
            />
          ))}
        </div>
      </div>

      <div
        id={`wallet-insight-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`wallet-insight-tab-${activeTab}`}
        className="border-t border-border/70"
      >
        {activeTab === "activity" ? (
          <ActivityLog profile={profile} events={events} />
        ) : (
          <div className="p-4 sm:p-5">
            <PortfolioMoversPanel
              rows={rows}
              profile={profile}
              marketOverview={marketOverview}
              loading={marketOverviewLoading}
            />
          </div>
        )}
      </div>
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
      <CalmEmptyState
        icon={Activity}
        label="No recent activity."
        className="min-h-[8rem]"
      />
    );
  }

  return (
    <div className="divide-y divide-border/60">
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
          <div className="flex min-h-[4.5rem] min-w-0 items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-bg-hover">
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-sm",
                toneClass,
              )}
            >
              <entry.icon className="size-4" />
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

export function InventoryAppView() {
  const authority = useActiveAgentAuthority();
  const {
    walletEnabled,
    walletAddresses,
    walletConfig,
    walletBalances,
    walletNfts,
    walletLoading,
    walletConfigStatus,
    walletConfigError,
    walletBalancesStatus,
    walletBalancesError,
    walletNftsStatus,
    walletNftsError,
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
    walletConfigStatus: s.walletConfigStatus,
    walletConfigError: s.walletConfigError,
    walletBalancesStatus: s.walletBalancesStatus,
    walletBalancesError: s.walletBalancesError,
    walletNftsStatus: s.walletNftsStatus,
    walletNftsError: s.walletNftsError,
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
  const [insightTab, setInsightTab] = useState<WalletInsightTab>("markets");
  const [marketOverview, setMarketOverview] =
    useState<WalletMarketOverviewResponse | null>(null);
  const [marketOverviewLoading, setMarketOverviewLoading] = useState(false);
  const initialLoadAuthorityRef = useRef<string | null>(null);
  const marketOverviewRequestRef = useRef(0);
  const marketOverviewAuthorityRef = useRef(authority);
  const marketOverviewCapabilityRef =
    useRef<OptionalCapabilityState>("unknown");

  const loadMarketOverview = useCallback(async () => {
    const requestAuthority = authority;
    if (getActiveAgentAuthority() !== requestAuthority) return;
    const requestId = marketOverviewRequestRef.current + 1;
    marketOverviewRequestRef.current = requestId;
    setMarketOverviewLoading(true);

    try {
      const overview = await client.getWalletMarketOverview();
      if (
        getActiveAgentAuthority() === requestAuthority &&
        marketOverviewRequestRef.current === requestId
      ) {
        marketOverviewCapabilityRef.current = "supported";
        marketOverviewAuthorityRef.current = requestAuthority;
        setMarketOverview(overview);
      }
    } catch (cause) {
      // error-policy:J4 — the market feed is an optional capability, but a
      // failed fetch is a *distinguishable* unavailable state, not a silent
      // null that reads as "empty". Publish an overview whose sources are all
      // marked unavailable with the error so the dashboard's market panels
      // render `MarketDataUnavailable` instead of a blank/absent panel.
      const unavailable = isOptionalCapabilityUnavailable(
        cause,
        "wallet_market_overview_unavailable",
      );
      const message = unavailable
        ? "Market data is not available for this wallet."
        : cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Market data is currently unavailable.";
      if (
        getActiveAgentAuthority() === requestAuthority &&
        marketOverviewRequestRef.current === requestId
      ) {
        if (unavailable) {
          marketOverviewCapabilityRef.current = "unavailable";
        }
        marketOverviewAuthorityRef.current = requestAuthority;
        setMarketOverview(marketOverviewUnavailable(message));
      }
    } finally {
      if (
        getActiveAgentAuthority() === requestAuthority &&
        marketOverviewRequestRef.current === requestId
      ) {
        setMarketOverviewLoading(false);
      }
    }
  }, [authority]);

  useEffect(() => {
    marketOverviewRequestRef.current += 1;
    marketOverviewAuthorityRef.current = authority;
    marketOverviewCapabilityRef.current = "unknown";
    setMarketOverview(null);
    setMarketOverviewLoading(false);
  }, [authority]);

  useEffect(() => {
    if (initialLoadAuthorityRef.current === authority) return;
    initialLoadAuthorityRef.current = authority;
    void loadWalletConfig();
    void loadMarketOverview();
    if (walletEnabled === false) return;
    void loadBalances();
    if (walletNftsStatus !== "unavailable") {
      void loadNfts();
    }
  }, [
    authority,
    loadBalances,
    loadMarketOverview,
    loadNfts,
    loadWalletConfig,
    walletEnabled,
    walletNftsStatus,
  ]);

  // No manual refresh control: keep balances, NFTs, and market data fresh with
  // a quiet background poll while the view is mounted.
  useEffect(() => {
    if (walletEnabled === false) return;
    const interval = window.setInterval(() => {
      void loadWalletConfig();
      void loadBalances();
      if (walletNftsStatus !== "unavailable") {
        void loadNfts();
      }
      if (marketOverviewCapabilityRef.current !== "unavailable") {
        void loadMarketOverview();
      }
    }, WALLET_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [
    loadBalances,
    loadMarketOverview,
    loadNfts,
    loadWalletConfig,
    walletEnabled,
    walletNftsStatus,
  ]);

  const activeMarketOverview =
    marketOverviewAuthorityRef.current === authority ? marketOverview : null;
  const activeMarketOverviewLoading =
    marketOverviewAuthorityRef.current === authority
      ? marketOverviewLoading
      : false;

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
    () =>
      inventoryData.tokenRowsAllChains.filter(
        (row) =>
          isSupportedWalletAssetChain(row.chain) && tokenHasInventory(row),
      ),
    [inventoryData.tokenRowsAllChains],
  );
  const displayedAssetRows = useMemo(
    () => visibleAssetRows.filter((row) => !hiddenTokenIds.has(tokenId(row))),
    [hiddenTokenIds, visibleAssetRows],
  );
  const visibleNfts = useMemo(
    () => supportedWalletNfts(walletNfts),
    [walletNfts],
  );
  const lpPositions = useMemo(
    () =>
      deriveInventoryPositionAssets({
        tokenRows: displayedAssetRows,
        nfts: visibleNfts,
      }),
    [displayedAssetRows, visibleNfts],
  );

  const hasWalletAccount = Boolean(
    addresses.evmAddress || addresses.solanaAddress,
  );
  // BNB-denominated legacy trading data stays available through the wallet API,
  // but its performance model remains intentionally absent from this surface.
  const primaryTradingProfile: WalletTradingProfileResponse | null = null;

  const showWalletEmptyState =
    walletEnabled === false ||
    !hasWalletAccount ||
    (walletBalancesStatus === "ready" &&
      walletNftsStatus === "ready" &&
      displayedAssetRows.length === 0 &&
      lpPositions.length === 0 &&
      visibleNfts.length === 0 &&
      activityEvents.length === 0);

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

  const handleRestoreHiddenTokens = useCallback(() => {
    const next = new Set<string>();
    setHiddenTokenIds(next);
    writeHiddenTokenIds(next);
    setActionNotice("Hidden tokens are visible again.");
  }, [setActionNotice]);

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
    if (walletNftsStatus !== "unavailable") {
      void loadNfts();
    }
  }, [loadBalances, loadNfts, loadWalletConfig, setState, walletNftsStatus]);

  const handleRetryWalletData = useCallback(() => {
    if (walletConfigError) {
      void loadWalletConfig();
    }
    if (
      walletEnabled !== false &&
      (walletBalancesError ||
        walletBalancesStatus === "error" ||
        walletBalancesStatus === "unavailable")
    ) {
      void loadBalances();
    }
  }, [
    loadBalances,
    loadWalletConfig,
    walletBalancesError,
    walletBalancesStatus,
    walletConfigError,
    walletEnabled,
  ]);

  const walletDataError = walletBalancesError ?? walletConfigError;
  const walletDataErrorMessage = walletBalancesError
    ? walletBalances === null
      ? "Balances are temporarily unavailable."
      : "Balance refresh failed. Showing your last snapshot."
    : walletConfigError
      ? "Wallet connection needs attention."
      : null;
  const balanceUnavailableWithoutSnapshot =
    walletEnabled !== false &&
    walletBalances === null &&
    (walletBalancesStatus === "error" ||
      walletBalancesStatus === "unavailable" ||
      walletBalancesError !== null);
  const balanceLoadingWithoutSnapshot =
    walletEnabled !== false &&
    walletBalances === null &&
    (walletLoading ||
      walletBalancesStatus === "idle" ||
      walletBalancesStatus === "loading");
  const walletIdentityLoadingWithoutSnapshot =
    walletEnabled !== false &&
    !hasWalletAccount &&
    (walletConfigStatus === "idle" || walletConfigStatus === "loading");

  return (
    <PagePanel.Frame
      as="main"
      data-testid="wallet-shell"
      className="flex-col bg-bg"
    >
      <PagePanel.ContentArea>
        <PagePanel.ContentRail
          width="standard"
          data-testid="wallet-content-rail"
          className="flex flex-col gap-5 pt-3 pb-[var(--view-pad-bottom)] sm:pt-5"
        >
          {balanceLoadingWithoutSnapshot ||
          walletIdentityLoadingWithoutSnapshot ? (
            <WalletBalancesLoadingState />
          ) : (
            <>
              {walletDataError && !balanceUnavailableWithoutSnapshot ? (
                <PagePanel.Notice
                  tone="danger"
                  role="alert"
                  className="rounded-sm bg-destructive-subtle px-3 py-2"
                  actions={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRetryWalletData}
                    >
                      Retry
                    </Button>
                  }
                >
                  <span className="inline-flex items-start gap-2">
                    <AlertTriangle
                      className="mt-0.5 size-4 shrink-0"
                      aria-hidden
                    />
                    <span>{walletDataErrorMessage}</span>
                  </span>
                </PagePanel.Notice>
              ) : null}

              {walletError && !walletDataError ? (
                <PagePanel.Notice
                  tone="danger"
                  role="alert"
                  className="rounded-sm bg-destructive-subtle px-3 py-2"
                >
                  <span className="inline-flex items-start gap-2">
                    <AlertTriangle
                      className="mt-0.5 size-4 shrink-0"
                      aria-hidden
                    />
                    <span>Wallet data is temporarily unavailable.</span>
                  </span>
                </PagePanel.Notice>
              ) : null}

              <WalletHoldingsSection
                rows={visibleAssetRows}
                walletBalances={walletBalances}
                nfts={visibleNfts}
                positions={lpPositions}
                addresses={addresses}
                hiddenTokenIds={hiddenTokenIds}
                walletConfig={walletConfig}
                profile={primaryTradingProfile}
                onHideToken={handleHideToken}
                onOpenRpcSettings={handleOpenRpcSettings}
                walletEnabled={walletEnabled}
                onEnableWallet={handleEnableWallet}
                loading={walletLoading}
                walletConfigStatus={walletConfigStatus}
                balancesStatus={walletBalancesStatus}
                nftsStatus={walletNftsStatus}
                nftsError={walletNftsError}
                onRetryNfts={loadNfts}
                onRetryBalances={handleRetryWalletData}
                showWalletEmptyState={showWalletEmptyState}
                onRestoreHiddenTokens={handleRestoreHiddenTokens}
              />

              {!showWalletEmptyState ? (
                <WalletInsightsPanel
                  activeTab={insightTab}
                  onSelectTab={setInsightTab}
                  profile={primaryTradingProfile}
                  events={activityEvents}
                  rows={displayedAssetRows}
                  marketOverview={activeMarketOverview}
                  marketOverviewLoading={activeMarketOverviewLoading}
                />
              ) : null}
            </>
          )}
        </PagePanel.ContentRail>
      </PagePanel.ContentArea>
    </PagePanel.Frame>
  );
}
