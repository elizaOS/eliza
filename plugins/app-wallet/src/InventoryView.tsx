import type {
  WalletAddresses,
  WalletConfigStatus,
  WalletMarketMover,
  WalletMarketOverviewResponse,
  WalletMarketOverviewSource,
  WalletMarketPrediction,
  WalletMarketPriceSnapshot,
  WalletTradingProfileResponse,
  WalletTradingProfileWindow,
} from "@elizaos/shared";
import type { InventoryChainFilters } from "@elizaos/ui";
import {
  type ActivityEvent,
  AppPageSidebar,
  Button,
  client,
  cn,
  PageLayout,
  SidebarContent,
  SidebarPanel,
  SidebarScrollRegion,
  useActivityEvents,
  useApp,
} from "@elizaos/ui";
import {
  Activity,
  ArrowDownLeft,
  ArrowLeftRight,
  BarChart3,
  Copy,
  EyeOff,
  Image as ImageIcon,
  Layers3,
  type LucideIcon,
  RefreshCw,
  Send,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getNativeLogoUrl } from "./inventory/chainConfig.ts";
import {
  formatBalance,
  type NftItem,
  type TokenRow,
} from "./inventory/constants.ts";
import { TokenLogo } from "./inventory/TokenLogo.tsx";
import { useInventoryData } from "./inventory/useInventoryData.ts";

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
const WALLET_CHAT_PREFILL_EVENT = "eliza:chat:prefill";
const WALLET_SIDEBAR_WIDTH_KEY = "eliza:wallets:sidebar:width";
const WALLET_SIDEBAR_COLLAPSED_KEY = "eliza:wallets:sidebar:collapsed";
const WALLET_SIDEBAR_DEFAULT_WIDTH = 352;
const WALLET_SIDEBAR_MIN_WIDTH = 240;
const WALLET_SIDEBAR_MAX_WIDTH = 520;
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

const compactDollarFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

function resolveWalletAddresses({
  walletAddresses,
  walletConfig,
}: {
  walletAddresses: WalletAddresses | null;
  walletConfig: WalletConfigStatus | null;
}): {
  evmAddress: string | null;
  solanaAddress: string | null;
} {
  return {
    evmAddress: walletAddresses?.evmAddress ?? walletConfig?.evmAddress ?? null,
    solanaAddress:
      walletAddresses?.solanaAddress ?? walletConfig?.solanaAddress ?? null,
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

function normalizeTokenAddress(address: string | null): string | null {
  return address ? address.toLowerCase() : null;
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return usdFormatter.format(0);
  return usdFormatter.format(value);
}

function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value)) return compactDollarFormatter.format(0);
  return compactDollarFormatter.format(value);
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

function formatProbability(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "No odds";
  return `${Math.round(value * 100)}%`;
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

function clampWalletSidebarWidth(value: number): number {
  return Math.min(
    Math.max(value, WALLET_SIDEBAR_MIN_WIDTH),
    WALLET_SIDEBAR_MAX_WIDTH,
  );
}

function loadInitialWalletSidebarWidth(): number {
  if (typeof window === "undefined") return WALLET_SIDEBAR_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(WALLET_SIDEBAR_WIDTH_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(parsed)) return clampWalletSidebarWidth(parsed);
  } catch {
    /* ignore sandboxed storage */
  }
  return WALLET_SIDEBAR_DEFAULT_WIDTH;
}

function loadInitialWalletSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(WALLET_SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function useWalletSidebarDesktopMode() {
  const [isDesktop, setIsDesktop] = useState(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return true;
    }
    return window.matchMedia("(min-width: 820px)").matches;
  });

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      setIsDesktop(true);
      return;
    }

    const mediaQuery = window.matchMedia("(min-width: 820px)");
    const update = () => setIsDesktop(mediaQuery.matches);

    update();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", update);
      return () => mediaQuery.removeEventListener("change", update);
    }

    mediaQuery.addListener(update);
    return () => mediaQuery.removeListener(update);
  }, []);

  return isDesktop;
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

function formatMarketEndsAt(value: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
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

function dispatchWalletChatPrefill(text: string): void {
  window.dispatchEvent(
    new CustomEvent(WALLET_CHAT_PREFILL_EVENT, {
      detail: { text, select: true },
    }),
  );
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
  const tone = pnl === 0 ? "text-muted" : pnl > 0 ? "text-ok" : "text-danger";
  const barTone =
    pnl === 0 ? "bg-border" : pnl > 0 ? "bg-ok/80" : "bg-danger/80";

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
}: {
  chain: string;
  size?: number;
  className?: string;
}) {
  const [errored, setErrored] = useState(false);
  const logoUrl = errored ? null : getNativeLogoUrl(chain);

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-bg shadow-sm ring-2 ring-bg",
        className,
      )}
      style={{ width: size, height: size }}
      title={chain}
      role="img"
      aria-label={chain}
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
      ? "bg-ok"
      : index === 2
        ? "bg-warn"
        : index === 3
          ? "bg-danger"
          : "bg-muted";
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
              className="inline-flex items-center gap-1.5 rounded-full border border-border/35 bg-bg/35 px-2.5 py-1 text-[0.68rem] font-medium text-txt"
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
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl bg-bg/35 px-3 py-2.5">
      <TokenIdentityIcon row={mover.row} size={34} />
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-txt">
          {mover.row.symbol}
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border/45">
          <div
            className={cn(
              "h-full rounded-full",
              isGain ? "bg-ok/85" : "bg-danger/85",
            )}
            style={{ width: `${width}%` }}
          />
        </div>
      </div>
      <div
        className={cn(
          "shrink-0 text-right font-mono text-xs font-semibold",
          isGain ? "text-ok" : "text-danger",
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
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted">
        {tone === "gain" ? (
          <TrendingUp className="h-3.5 w-3.5 text-ok" />
        ) : (
          <TrendingDown className="h-3.5 w-3.5 text-danger" />
        )}
        {title}
      </div>
      {movers.length > 0 ? (
        <div className="space-y-2">
          {movers.map((mover) => (
            <PortfolioMoverRow
              key={`${tokenId(mover.row)}:${mover.realizedPnlBnb}`}
              mover={mover}
              maxAbsPnl={maxAbsPnl}
            />
          ))}
        </div>
      ) : (
        <div className="flex h-[3.75rem] items-center rounded-2xl bg-bg/25 px-3 text-xs-tight text-muted">
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
        <div className="space-y-3">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
            Market-wide
          </div>
          <MarketMoverList
            movers={marketOverview.movers}
            source={marketOverview.sources.movers}
          />
        </div>
      );
    }

    return <EmptyState icon={TrendingUp} title="No movers yet" />;
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

function EmptyState({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body?: string;
}) {
  return (
    <div className="flex min-h-[8rem] flex-col items-center justify-center rounded-2xl bg-bg/30 px-4 py-6 text-center">
      <Icon className="mb-3 h-5 w-5 text-muted" />
      <div className="text-sm font-semibold text-txt">{title}</div>
      {body ? (
        <div className="mt-1 max-w-sm text-xs-tight text-muted">{body}</div>
      ) : null}
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
        className="h-11 w-11 shrink-0 rounded-2xl object-cover"
        loading="lazy"
      />
    );
  }

  return (
    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-bg/65 text-sm font-semibold text-txt">
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
      className="transition-opacity hover:opacity-80"
    >
      <span className="inline-flex items-center rounded-full border border-border/35 bg-bg/45 px-2.5 py-1 text-[0.68rem] font-semibold text-txt">
        {source.providerName}
      </span>
    </a>
  );
}

function MarketSectionHeader({
  icon: Icon,
  title,
  source,
}: {
  icon: LucideIcon;
  title: string;
  source: WalletMarketOverviewSource;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-sm font-semibold text-txt">
      <Icon className="h-4 w-4 text-accent" />
      <span>{title}</span>
      <MarketSourceBadge source={source} />
    </div>
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
    <div className="rounded-2xl border border-warn/20 bg-warn/10 px-4 py-3">
      <div className="text-sm font-semibold text-warn">{title} unavailable</div>
      <div className="mt-1 text-xs text-muted">
        {source.error ?? `${source.providerName} did not return live data.`}
      </div>
    </div>
  );
}

function MajorPriceCard({ snapshot }: { snapshot: WalletMarketPriceSnapshot }) {
  const isPositive = snapshot.change24hPct >= 0;

  return (
    <div className="min-w-0 rounded-[26px] border border-border/30 bg-bg/40 p-4">
      <div className="flex items-center gap-3">
        <MarketAvatar imageUrl={snapshot.imageUrl} label={snapshot.symbol} />
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
            {snapshot.symbol}
          </div>
          <div className="truncate text-sm font-medium text-txt">
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
            isPositive ? "text-ok" : "text-danger",
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
    return <EmptyState icon={BarChart3} title="No price snapshots yet" />;
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
    return <EmptyState icon={TrendingUp} title="No market movers yet" />;
  }

  return (
    <div className="space-y-2">
      {movers.map((mover) => {
        const isPositive = mover.change24hPct >= 0;
        return (
          <div
            key={mover.id}
            className="flex min-w-0 items-center gap-3 rounded-2xl bg-bg/35 px-3 py-3"
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
                <div className="mt-1 text-[0.68rem] font-medium uppercase tracking-[0.08em] text-muted">
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
                  isPositive ? "text-ok" : "text-danger",
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

function MarketPredictionList({
  predictions,
  source,
}: {
  predictions: WalletMarketPrediction[];
  source: WalletMarketOverviewSource;
}) {
  if (!source.available) {
    return (
      <MarketDataUnavailable title="Popular predictions" source={source} />
    );
  }

  if (predictions.length === 0) {
    return <EmptyState icon={Sparkles} title="No predictions yet" />;
  }

  return (
    <div className="space-y-2">
      {predictions.map((prediction) => {
        const href = prediction.slug
          ? `https://polymarket.com/event/${prediction.slug}`
          : null;
        const endsAtLabel = formatMarketEndsAt(prediction.endsAt);
        const content = (
          <div
            key={prediction.id}
            className="flex min-w-0 items-center gap-3 rounded-2xl bg-bg/35 px-3 py-3 transition-colors hover:bg-bg/50"
          >
            <MarketAvatar
              imageUrl={prediction.imageUrl}
              label={prediction.highlightedOutcomeLabel}
            />
            <div className="min-w-0 flex-1">
              <div className="line-clamp-2 text-sm font-medium text-txt">
                {prediction.question}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[0.68rem] font-medium uppercase tracking-[0.08em] text-muted">
                <span>
                  {prediction.highlightedOutcomeLabel}{" "}
                  {formatProbability(prediction.highlightedOutcomeProbability)}
                </span>
                <span>{formatCompactUsd(prediction.volume24hUsd)} 24h vol</span>
                {endsAtLabel ? <span>Ends {endsAtLabel}</span> : null}
              </div>
            </div>
          </div>
        );

        return href ? (
          <a key={prediction.id} href={href} target="_blank" rel="noreferrer">
            {content}
          </a>
        ) : (
          <div key={prediction.id}>{content}</div>
        );
      })}
    </div>
  );
}

function MarketPulseHero({
  overview,
  loading,
  error,
}: {
  overview: WalletMarketOverviewResponse | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <section className="space-y-6">
      <div className="max-w-2xl">
        <h2 className="text-2xl font-semibold leading-tight text-txt md:text-[2rem]">
          No balances or trade history yet.
        </h2>
        <p className="mt-2 max-w-xl text-sm text-muted">
          {overview?.stale
            ? "Here's the latest cached market snapshot."
            : "Here's what the market looks like right now."}
        </p>
      </div>

      {overview ? (
        <div className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.92fr)]">
          <div className="space-y-4">
            <div>
              <MarketSectionHeader
                icon={BarChart3}
                title="Spot prices"
                source={overview.sources.prices}
              />
              <MarketPriceGrid
                prices={overview.prices}
                source={overview.sources.prices}
              />
            </div>

            <div>
              <MarketSectionHeader
                icon={TrendingUp}
                title="Top movers"
                source={overview.sources.movers}
              />
              <MarketMoverList
                movers={overview.movers}
                source={overview.sources.movers}
              />
            </div>
          </div>

          <div>
            <MarketSectionHeader
              icon={Sparkles}
              title="Popular predictions"
              source={overview.sources.predictions}
            />
            <MarketPredictionList
              predictions={overview.predictions}
              source={overview.sources.predictions}
            />
          </div>
        </div>
      ) : loading ? (
        <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(min(100%,13.5rem),1fr))] gap-3">
          {["btc", "eth", "sol"].map((placeholderId) => (
            <div
              key={placeholderId}
              className="h-28 animate-pulse rounded-[26px] border border-border/30 bg-bg/35"
            />
          ))}
        </div>
      ) : error ? (
        <div className="mt-6 rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
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
      <div className="flex h-40 items-center justify-center rounded-3xl bg-bg/30 text-xs text-muted">
        No realized P&L yet
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
  const stroke = latest >= 0 ? "rgb(var(--ok-rgb))" : "rgb(var(--danger-rgb))";

  return (
    <svg
      className="h-40 w-full rounded-3xl bg-bg/30"
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
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium",
        tone === "gain"
          ? "border-ok/30 bg-ok/10 text-ok"
          : tone === "loss"
            ? "border-danger/30 bg-danger/10 text-danger"
            : "border-border/35 bg-bg/35 text-txt",
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
}: {
  address: string | null;
  chains: string[];
  emptyLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!address) return;
    void navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [address]);

  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-center justify-between gap-3 py-1 text-left transition-colors hover:text-txt"
      onClick={handleCopy}
      disabled={!address}
      title={address ?? emptyLabel}
      aria-label={
        address ? `Copy ${emptyLabel} address` : `${emptyLabel} unavailable`
      }
    >
      <span className="flex min-w-0 items-center gap-3">
        <span className="flex shrink-0 -space-x-1.5">
          {chains.map((chain) => (
            <ChainLogoBadge
              key={chain}
              chain={chain}
              size={18}
              className="ring-1 ring-bg"
            />
          ))}
        </span>
        <span
          className={cn(
            "truncate font-mono text-xs",
            address ? "text-txt" : "text-muted",
          )}
        >
          {address ?? emptyLabel}
        </span>
      </span>
      {address ? (
        copied ? (
          <span className="shrink-0 text-[0.68rem] font-semibold text-ok">
            Copied
          </span>
        ) : (
          <Copy className="h-3.5 w-3.5 shrink-0 text-muted" />
        )
      ) : null}
    </button>
  );
}

function WalletRailRpcButton({
  walletConfig,
  onOpenSettings,
}: {
  walletConfig: WalletConfigStatus | null;
  onOpenSettings: () => void;
}) {
  const evmReady = Boolean(walletConfig?.evmBalanceReady);
  const solanaReady = Boolean(walletConfig?.solanaBalanceReady);
  const toneClass = !walletConfig
    ? "bg-muted"
    : evmReady && solanaReady
      ? "bg-ok"
      : evmReady || solanaReady
        ? "bg-warn"
        : "bg-danger";
  const evmProvider = providerLabel(
    walletConfig?.selectedRpcProviders?.evm,
    "evm",
  );
  const solanaProvider = providerLabel(
    walletConfig?.selectedRpcProviders?.solana,
    "solana",
  );

  return (
    <button
      type="button"
      className="inline-flex h-8 items-center gap-2 rounded-full border border-border/35 bg-bg/35 px-3 text-xs font-semibold text-txt transition-colors hover:bg-bg/55"
      onClick={onOpenSettings}
      title={`EVM: ${evmProvider} • Solana: ${solanaProvider}`}
      aria-label="Open RPC settings"
    >
      <span className={cn("h-2 w-2 rounded-full", toneClass)} />
      RPC
    </button>
  );
}

function WalletRailAccount({
  addresses,
  portfolioValueUsd,
  walletConfig,
  onOpenSettings,
  onRefresh,
  refreshing,
}: {
  addresses: { evmAddress: string | null; solanaAddress: string | null };
  portfolioValueUsd: number;
  walletConfig: WalletConfigStatus | null;
  onOpenSettings: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="font-mono text-xl font-semibold leading-none text-txt">
          {formatUsd(portfolioValueUsd)}
        </div>
        <div className="flex items-center gap-2">
          <WalletRailRpcButton
            walletConfig={walletConfig}
            onOpenSettings={onOpenSettings}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 rounded-full border border-border/35 bg-bg/35 hover:bg-bg/55"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh wallet"
            title="Refresh wallet"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", refreshing && "animate-spin")}
            />
          </Button>
        </div>
      </div>
      <WalletRailAddress
        address={addresses.evmAddress}
        chains={SUPPORTED_WALLET_CHAINS.filter((chain) => chain !== "solana")}
        emptyLabel="No EVM address"
      />
      <WalletRailAddress
        address={addresses.solanaAddress}
        chains={["solana"]}
        emptyLabel="No Solana address"
      />
    </div>
  );
}

function WalletRailActionButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex min-w-0 flex-col items-center justify-center gap-2 rounded-2xl border border-border/35 bg-bg/55 px-2 py-3 text-xs font-semibold text-txt transition-[transform,background-color,border-color,color,box-shadow] duration-150 hover:border-border/55 hover:bg-bg/80 hover:shadow-sm active:scale-[0.99]"
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <Icon className="h-4.5 w-4.5 text-accent" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function WalletRailEmpty({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body?: string;
}) {
  return (
    <div className="flex min-h-[13rem] flex-col items-center justify-center px-5 text-center">
      <Icon className="mb-3 h-5 w-5 text-muted" />
      <div className="text-sm font-semibold text-txt">{title}</div>
      {body ? (
        <div className="mt-1 text-xs-tight text-muted">{body}</div>
      ) : null}
    </div>
  );
}

function TokenRailRow({
  row,
  profile,
  maxPnl,
  onHideToken,
  onTokenAction,
}: {
  row: TokenRow;
  profile: WalletTradingProfileResponse | null;
  maxPnl: number;
  onHideToken: (row: TokenRow) => void;
  onTokenAction: (row: TokenRow, action: "swap" | "bridge") => void;
}) {
  return (
    <div className="group flex min-w-0 items-center gap-3 rounded-2xl px-2.5 py-2.5 transition-colors hover:bg-bg/55">
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
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-bg/65 text-muted transition-colors hover:text-txt"
            onClick={() => onTokenAction(row, "swap")}
            aria-label={`Swap ${row.symbol}`}
            title={`Swap ${row.symbol}`}
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-bg/65 text-muted transition-colors hover:text-txt"
            onClick={() => onTokenAction(row, "bridge")}
            aria-label={`Bridge ${row.symbol}`}
            title={`Bridge ${row.symbol}`}
          >
            <Layers3 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-bg/65 text-muted transition-colors hover:text-danger"
            onClick={() => onHideToken(row)}
            aria-label={`Hide ${row.symbol}`}
            title={`Hide ${row.symbol}`}
          >
            <EyeOff className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function RailNftList({ nfts }: { nfts: NftItem[] }) {
  if (nfts.length === 0) {
    return <WalletRailEmpty icon={ImageIcon} title="No NFTs" />;
  }

  return (
    <div className="space-y-1">
      {nfts.slice(0, 20).map((nft) => (
        <div
          key={`${nft.chain}:${nft.collectionName}:${nft.name}:${nft.imageUrl}`}
          className="flex min-w-0 items-center gap-3 rounded-2xl px-2.5 py-2.5 transition-colors hover:bg-bg/55"
        >
          {nft.imageUrl ? (
            <img
              src={nft.imageUrl}
              alt={nft.name}
              className="h-11 w-11 shrink-0 rounded-2xl object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-bg/65">
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
    return <WalletRailEmpty icon={Layers3} title="No positions" />;
  }

  return (
    <div className="space-y-1">
      {positions.map((position) => (
        <div
          key={position.id}
          className="flex min-w-0 items-center gap-3 rounded-2xl px-2.5 py-2.5 transition-colors hover:bg-bg/55"
        >
          {position.imageUrl ? (
            <img
              src={position.imageUrl}
              alt={position.label}
              className="h-11 w-11 shrink-0 rounded-2xl object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-bg/65">
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

function TokenRail({
  rows,
  nfts,
  positions,
  addresses,
  hiddenTokenIds,
  walletConfig,
  profile,
  onHideToken,
  onTokenAction,
  onWalletAction,
  onOpenRpcSettings,
  onRefresh,
  refreshing,
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
  onTokenAction: (row: TokenRow, action: "swap" | "bridge") => void;
  onWalletAction: (action: "swap" | "send" | "receive") => void;
  onOpenRpcSettings: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  walletEnabled: boolean | null;
  onEnableWallet: () => void;
}) {
  const [activeTab, setActiveTab] = useState<WalletRailTab>("tokens");
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    loadInitialWalletSidebarCollapsed,
  );
  const [sidebarWidth, setSidebarWidth] = useState<number>(
    loadInitialWalletSidebarWidth,
  );
  const isDesktopSidebar = useWalletSidebarDesktopMode();
  const showIconOnlyTabs =
    isDesktopSidebar && !sidebarCollapsed && sidebarWidth <= 304;
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
    {
      id: "tokens",
      label: "Tokens",
      icon: Wallet,
    },
    { id: "defi", label: "DeFi", icon: Layers3 },
    { id: "nfts", label: "NFTs", icon: ImageIcon },
  ];
  const handleSidebarCollapsedChange = useCallback((next: boolean) => {
    setSidebarCollapsed(next);
    try {
      window.localStorage.setItem(WALLET_SIDEBAR_COLLAPSED_KEY, String(next));
    } catch {
      /* ignore sandboxed storage */
    }
  }, []);
  const handleSidebarWidthChange = useCallback((next: number) => {
    const clamped = clampWalletSidebarWidth(next);
    setSidebarWidth(clamped);
    try {
      window.localStorage.setItem(WALLET_SIDEBAR_WIDTH_KEY, String(clamped));
    } catch {
      /* ignore sandboxed storage */
    }
  }, []);
  const headerContent = (
    <div className="space-y-4">
      {visibleRows.length > 0 ? (
        <AssetAllocationStrip rows={visibleRows} compact />
      ) : null}

      {walletEnabled === false ? (
        <Button className="w-full rounded-2xl" onClick={onEnableWallet}>
          Enable wallet
        </Button>
      ) : null}

      <div className="grid grid-cols-3 gap-2">
        <WalletRailActionButton
          icon={ArrowLeftRight}
          label="Swap"
          onClick={() => onWalletAction("swap")}
        />
        <WalletRailActionButton
          icon={Send}
          label="Send"
          onClick={() => onWalletAction("send")}
        />
        <WalletRailActionButton
          icon={ArrowDownLeft}
          label="Receive"
          onClick={() => onWalletAction("receive")}
        />
      </div>

      <div className="grid min-w-0 grid-cols-3 rounded-2xl bg-bg/45 p-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={cn(
              "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-[calc(var(--radius-lg)_-_4px)] px-3 py-2 text-sm font-semibold transition-colors",
              showIconOnlyTabs ? "px-2" : undefined,
              activeTab === tab.id
                ? "bg-bg text-txt shadow-sm"
                : "text-muted hover:text-txt",
            )}
            onClick={() => setActiveTab(tab.id)}
            aria-label={tab.label}
            title={tab.label}
          >
            <tab.icon className="h-3.5 w-3.5 shrink-0" />
            {!showIconOnlyTabs ? (
              <span className="truncate">{tab.label}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <AppPageSidebar
      testId="wallets-sidebar"
      collapsible
      collapsed={sidebarCollapsed}
      onCollapsedChange={handleSidebarCollapsedChange}
      resizable
      width={sidebarWidth}
      onWidthChange={handleSidebarWidthChange}
      minWidth={WALLET_SIDEBAR_MIN_WIDTH}
      maxWidth={WALLET_SIDEBAR_MAX_WIDTH}
      onCollapseRequest={() => handleSidebarCollapsedChange(true)}
      contentIdentity={`wallets:${activeTab}`}
      collapseButtonTestId="wallets-sidebar-collapse-toggle"
      collapseButtonAriaLabel="Collapse wallet"
      expandButtonTestId="wallets-sidebar-expand-toggle"
      expandButtonAriaLabel="Expand wallet"
      collapsedRailItems={tabs.map((tab) => (
        <SidebarContent.RailItem
          key={tab.id}
          aria-label={tab.label}
          title={tab.label}
          active={activeTab === tab.id}
          onClick={() => setActiveTab(tab.id)}
        >
          <tab.icon className="h-4 w-4" />
        </SidebarContent.RailItem>
      ))}
      mobileTitle="Wallet"
      mobileMeta={null}
    >
      <div className="shrink-0 px-4 pb-3 pt-0">
        <WalletRailAccount
          addresses={addresses}
          portfolioValueUsd={totalUsd}
          walletConfig={walletConfig}
          onOpenSettings={onOpenRpcSettings}
          onRefresh={onRefresh}
          refreshing={refreshing}
        />
        <div className="mt-4">{headerContent}</div>
      </div>
      <SidebarScrollRegion className="pt-0">
        <SidebarPanel className="space-y-1">
          {activeTab === "tokens" ? (
            visibleRows.length === 0 ? (
              <WalletRailEmpty icon={Wallet} title="No assets" />
            ) : (
              visibleRows.map((row) => (
                <TokenRailRow
                  key={tokenId(row)}
                  row={row}
                  profile={profile}
                  maxPnl={maxPnl}
                  onHideToken={onHideToken}
                  onTokenAction={onTokenAction}
                />
              ))
            )
          ) : activeTab === "defi" ? (
            <RailPositionList positions={positions} />
          ) : activeTab === "nfts" ? (
            <RailNftList nfts={nfts} />
          ) : null}
        </SidebarPanel>
      </SidebarScrollRegion>
    </AppPageSidebar>
  );
}

function DashboardSection({
  title,
  icon: Icon,
  action,
  children,
}: {
  title: string;
  icon: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-border/30 bg-bg/45 px-5 py-5 md:px-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-txt">
          <Icon className="h-4 w-4 text-accent" />
          {title}
        </div>
        {action}
      </div>
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
    return <EmptyState icon={Activity} title="No activity yet" />;
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
          <div className="flex min-w-0 items-center gap-3 rounded-2xl bg-bg/35 px-3 py-2.5 text-sm transition-colors hover:bg-bg/55">
            <span
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
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
    return <EmptyState icon={ImageIcon} title="No NFTs" />;
  }

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      {visible.map((nft) => (
        <div
          key={`${nft.chain}:${nft.collectionName}:${nft.name}:${nft.imageUrl}`}
          className="overflow-hidden rounded-2xl bg-bg/35"
        >
          {nft.imageUrl ? (
            <img
              src={nft.imageUrl}
              alt={nft.name}
              className="aspect-square w-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex aspect-square items-center justify-center bg-bg/50">
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
    return <EmptyState icon={Layers3} title="No positions" />;
  }

  return (
    <div className="grid gap-2">
      {positions.map((position) => (
        <div
          key={position.id}
          className="flex min-w-0 items-center gap-3 rounded-2xl bg-bg/35 p-3"
        >
          {position.imageUrl ? (
            <img
              src={position.imageUrl}
              alt={position.label}
              className="h-10 w-10 shrink-0 rounded-2xl object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-bg/50">
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

export function InventoryView() {
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
  } = useApp();
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
  const [marketOverviewError, setMarketOverviewError] = useState<string | null>(
    null,
  );
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
    setMarketOverviewError(null);

    try {
      const overview = await client.getWalletMarketOverview();
      if (marketOverviewRequestRef.current === requestId) {
        setMarketOverview(overview);
      }
    } catch (cause) {
      const message =
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Failed to load market overview.";
      if (marketOverviewRequestRef.current === requestId) {
        setMarketOverviewError(message);
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

  const inventoryData = useInventoryData({
    walletBalances,
    walletAddresses,
    walletConfig,
    walletNfts,
    inventorySort: "value",
    inventorySortDirection: "desc",
    inventoryChainFilters: ALL_INVENTORY_FILTERS,
  });

  const addresses = resolveWalletAddresses({
    walletAddresses,
    walletConfig,
  });

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

  const handleRefresh = useCallback(() => {
    void loadWalletConfig();
    void loadBalances();
    void loadNfts();
    void loadTradingProfile();
    void loadMarketOverview();
  }, [
    loadBalances,
    loadMarketOverview,
    loadNfts,
    loadTradingProfile,
    loadWalletConfig,
  ]);

  const handleTokenAction = useCallback(
    (row: TokenRow, action: "swap" | "bridge") => {
      const verb = action === "swap" ? "swap" : "bridge";
      dispatchWalletChatPrefill(
        `Prepare a ${verb} for ${row.symbol}. Use the visible wallet inventory, then ask me for amount, destination, slippage, and execution path before any transaction.`,
      );
      setActionNotice(
        `Prepared a ${verb} request for ${row.symbol} in wallet chat.`,
      );
    },
    [setActionNotice],
  );

  const handleWalletAction = useCallback(
    (action: "swap" | "send" | "receive") => {
      const prompt =
        action === "swap"
          ? "Prepare a wallet swap. Ask me for source token, destination token, amount, slippage, and route before any transaction."
          : action === "send"
            ? "Prepare a transfer. Ask me for token, amount, recipient address, and network requirements before any transaction."
            : "Show the EVM and Solana receive addresses available in this wallet and ask which address I want to use.";
      dispatchWalletChatPrefill(prompt);
      setActionNotice(`Prepared ${action} in wallet chat.`);
    },
    [setActionNotice],
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

  const tokenSidebar = (
    <TokenRail
      rows={visibleAssetRows}
      nfts={inventoryData.allNfts}
      positions={lpPositions}
      addresses={addresses}
      hiddenTokenIds={hiddenTokenIds}
      walletConfig={walletConfig}
      profile={tradingProfile}
      onHideToken={handleHideToken}
      onTokenAction={handleTokenAction}
      onWalletAction={handleWalletAction}
      onOpenRpcSettings={handleOpenRpcSettings}
      onRefresh={handleRefresh}
      refreshing={
        walletLoading ||
        walletNftsLoading ||
        tradingProfileLoading ||
        marketOverviewLoading
      }
      walletEnabled={walletEnabled}
      onEnableWallet={handleEnableWallet}
    />
  );

  return (
    <PageLayout
      className="h-full"
      data-testid="wallet-shell"
      sidebar={tokenSidebar}
      contentClassName="bg-bg"
      contentInnerClassName="w-full min-h-0"
      mobileSidebarLabel="Wallet"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-7 px-5 py-6 sm:px-7 lg:px-9">
        {walletError ? (
          <div className="rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger">
            {walletError}
          </div>
        ) : null}

        {showMarketPulseHero ? (
          <MarketPulseHero
            overview={marketOverview}
            loading={marketOverviewLoading}
            error={marketOverviewError}
          />
        ) : null}

        {!showMarketPulseHero ? (
          <div className="grid gap-8 xl:grid-cols-[minmax(0,1.22fr)_minmax(20rem,0.8fr)]">
            <div className="space-y-8">
              <DashboardSection
                title="P&L"
                icon={BarChart3}
                action={
                  <div className="flex rounded-full bg-bg/40 p-1">
                    {DASHBOARD_WINDOWS.map((window) => (
                      <button
                        key={window}
                        type="button"
                        className={cn(
                          "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                          dashboardWindow === window
                            ? "bg-accent text-[color:var(--accent-foreground)]"
                            : "text-muted hover:text-txt",
                        )}
                        onClick={() => setDashboardWindow(window)}
                      >
                        {window}
                      </button>
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
                        <AssetAllocationStrip
                          rows={displayedAssetRows}
                          compact
                        />
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

              <DashboardSection title="Activity" icon={Activity}>
                <ActivityLog profile={tradingProfile} events={activityEvents} />
              </DashboardSection>
            </div>

            <div className="space-y-8">
              <DashboardSection title="Movers" icon={TrendingUp}>
                <PortfolioMoversPanel
                  rows={displayedAssetRows}
                  profile={tradingProfile}
                  marketOverview={marketOverview}
                />
              </DashboardSection>

              <DashboardSection title="LP positions" icon={Layers3}>
                <LpPositionsPanel positions={lpPositions} />
              </DashboardSection>

              <DashboardSection title="NFTs" icon={ImageIcon}>
                <NftPreview nfts={inventoryData.allNfts} />
              </DashboardSection>
            </div>
          </div>
        ) : null}
      </div>
    </PageLayout>
  );
}
