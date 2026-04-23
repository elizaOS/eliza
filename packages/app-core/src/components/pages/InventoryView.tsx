import type {
  WalletAddresses,
  WalletConfigStatus,
  WalletTradingProfileResponse,
  WalletTradingProfileWindow,
} from "@elizaos/shared/contracts/wallet";
import {
  Button,
  cn,
  PageLayout,
  Sidebar,
  SidebarPanel,
  SidebarScrollRegion,
} from "@elizaos/ui";
import {
  Activity,
  ArrowDownLeft,
  ArrowLeftRight,
  BarChart3,
  ChevronDown,
  ChevronsLeft,
  Copy,
  DollarSign,
  EyeOff,
  Image as ImageIcon,
  Layers3,
  type LucideIcon,
  PieChart,
  RefreshCw,
  Search,
  Send,
  Settings,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client } from "../../api";
import type { InventoryChainFilters } from "../../state/types";
import { useApp } from "../../state/useApp";
import { getNativeLogoUrl } from "../inventory/chainConfig";
import {
  formatBalance,
  type NftItem,
  type TokenRow,
} from "../inventory/constants";
import { TokenLogo } from "../inventory/TokenLogo";
import { useInventoryData } from "../inventory/useInventoryData";

type DashboardWindow = "24h" | "7d" | "30d";
type WalletRailTab = "tokens" | "defi" | "nfts" | "activity";

const ALL_INVENTORY_FILTERS: InventoryChainFilters = {
  ethereum: true,
  base: true,
  bsc: true,
  avax: true,
  solana: true,
};

const DASHBOARD_WINDOWS: DashboardWindow[] = ["24h", "7d", "30d"];
const HIDDEN_TOKEN_IDS_KEY = "milady:wallet:hidden-token-ids:v1";
const WALLET_CHAT_PREFILL_EVENT = "milady:chat:prefill";
const WALLET_SIDEBAR_WIDTH_KEY = "milady:wallets:sidebar:width";
const WALLET_SIDEBAR_COLLAPSED_KEY = "milady:wallets:sidebar:collapsed";
const WALLET_SIDEBAR_DEFAULT_WIDTH = 352;
const WALLET_SIDEBAR_MIN_WIDTH = 240;
const WALLET_SIDEBAR_MAX_WIDTH = 520;
const VINCENT_APP_NAME = "@elizaos/app-vincent";

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

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const compactFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 4,
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

function shortAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
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
    return window.matchMedia("(min-width: 768px)").matches;
  });

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      setIsDesktop(true);
      return;
    }

    const mediaQuery = window.matchMedia("(min-width: 768px)");
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

function AssetAllocationStrip({ rows }: { rows: TokenRow[] }) {
  const allocationRows = useMemo(() => assetAllocationRows(rows), [rows]);
  const total = allocationRows.reduce((sum, row) => sum + row.valueUsd, 0);
  if (total <= 0 || allocationRows.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex h-2 overflow-hidden rounded-full bg-border/40">
        {allocationRows.map((row, index) => (
          <span
            key={tokenId(row)}
            className={cn(
              "h-full",
              index === 0
                ? "bg-accent"
                : index === 1
                  ? "bg-ok"
                  : index === 2
                    ? "bg-warn"
                    : index === 3
                      ? "bg-danger"
                      : "bg-muted",
            )}
            style={{ width: `${(row.valueUsd / total) * 100}%` }}
            title={`${row.symbol}: ${formatUsd(row.valueUsd)}`}
          />
        ))}
      </div>
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
    </div>
  );
}

function WalletCompositionPanel({ rows }: { rows: TokenRow[] }) {
  const allocationRows = useMemo(() => assetAllocationRows(rows), [rows]);
  const compositionRows =
    allocationRows.length > 0 ? allocationRows : rows.slice(0, 5);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Wallet}
        title="No visible tokens"
        body="Balances will show here."
      />
    );
  }

  return (
    <div className="space-y-4">
      <AssetAllocationStrip rows={rows} />
      <div className="grid gap-2 sm:grid-cols-2">
        {compositionRows.map((row) => (
          <div
            key={tokenId(row)}
            className="flex min-w-0 items-center gap-3 rounded-2xl bg-bg/35 p-3"
          >
            <TokenIdentityIcon row={row} size={36} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-txt">
                {row.symbol}
              </div>
              <div className="truncate text-xs-tight text-muted">
                {formatBalance(row.balance)}
              </div>
            </div>
            {row.valueUsd > 0 ? (
              <div className="shrink-0 font-mono text-sm font-semibold text-txt">
                {formatUsd(row.valueUsd)}
              </div>
            ) : null}
          </div>
        ))}
      </div>
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
}: {
  rows: TokenRow[];
  profile: WalletTradingProfileResponse | null;
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
    return (
      <EmptyState
        icon={TrendingUp}
        title="No trade movers"
        body="Closed trades will show here."
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

function AddressPill({
  label,
  address,
}: {
  label: string;
  address: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (!address) return;
    void navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [address]);

  if (!address) {
    return (
      <div className="min-w-0 rounded-2xl border border-border/35 bg-bg/35 px-3 py-2">
        <span className="block text-[0.65rem] uppercase tracking-[0.08em] text-muted">
          {label}
        </span>
        <span className="mt-0.5 block truncate font-mono text-xs text-muted">
          No address
        </span>
      </div>
    );
  }

  return (
    <Button
      variant="outline"
      className="min-w-0 justify-between gap-2 rounded-2xl border-border/35 bg-bg/35 px-3 py-2 text-left"
      onClick={handleCopy}
      title={address}
    >
      <span className="min-w-0">
        <span className="block text-[0.65rem] uppercase tracking-[0.08em] text-muted">
          {label}
        </span>
        <span className="block truncate font-mono text-xs text-txt">
          {shortAddress(address)}
        </span>
      </span>
      {copied ? (
        <span className="text-xs text-ok">Copied</span>
      ) : (
        <Copy className="h-3.5 w-3.5 shrink-0 text-muted" />
      )}
    </Button>
  );
}

function EmptyState({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  return (
    <div className="flex min-h-[8rem] flex-col items-center justify-center rounded-2xl bg-bg/30 px-4 py-6 text-center">
      <Icon className="mb-3 h-5 w-5 text-muted" />
      <div className="text-sm font-semibold text-txt">{title}</div>
      <div className="mt-1 max-w-sm text-xs-tight text-muted">{body}</div>
    </div>
  );
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
        No closed trades yet
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

function StatCard({
  label,
  value,
  detail,
  tone = "text-txt",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[0.68rem] uppercase tracking-[0.08em] text-muted">
        {label}
      </div>
      <div className={cn("mt-1 text-xl font-semibold", tone)}>{value}</div>
      {detail ? (
        <div className="mt-1 text-xs-tight text-muted">{detail}</div>
      ) : null}
    </div>
  );
}

function WalletRailAccount({
  addresses,
}: {
  addresses: { evmAddress: string | null; solanaAddress: string | null };
}) {
  const primaryAddress = addresses.evmAddress ?? addresses.solanaAddress;
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!primaryAddress) return;
    void navigator.clipboard.writeText(primaryAddress).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [primaryAddress]);

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-txt">
        <span>Account 1</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted" />
      </div>
      {primaryAddress ? (
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[0.68rem] text-muted">
          <span className="truncate">{shortAddress(primaryAddress)}</span>
          <button
            type="button"
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:text-txt"
            onClick={handleCopy}
            aria-label="Copy primary wallet address"
            title="Copy primary wallet address"
          >
            {copied ? (
              <span className="text-[0.6rem] text-ok">✓</span>
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </div>
      ) : (
        <div className="mt-0.5 text-[0.68rem] text-muted">No address</div>
      )}
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
      className="flex min-w-0 flex-col items-center justify-center gap-2 rounded-2xl bg-bg/55 px-2 py-3 text-xs font-semibold text-txt transition-colors hover:bg-bg/80"
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
  body: string;
}) {
  return (
    <div className="flex min-h-[13rem] flex-col items-center justify-center px-5 text-center">
      <Icon className="mb-3 h-5 w-5 text-muted" />
      <div className="text-sm font-semibold text-txt">{title}</div>
      <div className="mt-1 text-xs-tight text-muted">{body}</div>
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
    return (
      <WalletRailEmpty
        icon={ImageIcon}
        title="No NFTs"
        body="Collections will show here."
      />
    );
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
    return (
      <WalletRailEmpty
        icon={Layers3}
        title="No DeFi assets"
        body="LPs and vaults will show here."
      />
    );
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

function RailActivityList({
  profile,
}: {
  profile: WalletTradingProfileResponse | null;
}) {
  const recent = profile?.recentSwaps ?? [];

  if (recent.length === 0) {
    return (
      <WalletRailEmpty
        icon={Activity}
        title="No activity"
        body="Settled trades will show here."
      />
    );
  }

  return (
    <div className="space-y-1">
      {recent.slice(0, 12).map((swap) => (
        <a
          key={swap.hash}
          href={swap.explorerUrl}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-0 items-center justify-between gap-3 rounded-2xl px-2.5 py-2.5 transition-colors hover:bg-bg/55"
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-txt">
              {swap.side === "buy" ? "Bought" : "Sold"} {swap.tokenSymbol}
            </div>
            <div className="truncate text-xs-tight text-muted">
              {swap.inputAmount} {swap.inputSymbol} {"->"} {swap.outputAmount}{" "}
              {swap.outputSymbol}
            </div>
          </div>
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-1 text-[0.62rem] uppercase",
              swap.status === "success"
                ? "bg-ok/10 text-ok"
                : swap.status === "pending"
                  ? "bg-warn/10 text-warn"
                  : "bg-danger/10 text-danger",
            )}
          >
            {swap.status}
          </span>
        </a>
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
  searchQuery,
  profile,
  onSearchChange,
  onHideToken,
  onTokenAction,
  onWalletAction,
}: {
  rows: TokenRow[];
  nfts: NftItem[];
  positions: InventoryPositionAsset[];
  addresses: { evmAddress: string | null; solanaAddress: string | null };
  hiddenTokenIds: Set<string>;
  searchQuery: string;
  profile: WalletTradingProfileResponse | null;
  onSearchChange: (value: string) => void;
  onHideToken: (row: TokenRow) => void;
  onTokenAction: (row: TokenRow, action: "swap" | "bridge") => void;
  onWalletAction: (action: "buy" | "swap" | "send" | "receive") => void;
}) {
  const [activeTab, setActiveTab] = useState<WalletRailTab>("tokens");
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    loadInitialWalletSidebarCollapsed,
  );
  const [sidebarWidth, setSidebarWidth] = useState<number>(
    loadInitialWalletSidebarWidth,
  );
  const isDesktopSidebar = useWalletSidebarDesktopMode();
  const filteredRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return rows.filter((row) => {
      if (hiddenTokenIds.has(tokenId(row))) return false;
      if (!tokenHasInventory(row)) return false;
      if (!query) return true;
      return (
        row.symbol.toLowerCase().includes(query) ||
        row.name.toLowerCase().includes(query) ||
        row.contractAddress?.toLowerCase().includes(query)
      );
    });
  }, [hiddenTokenIds, rows, searchQuery]);
  const totalUsd = useMemo(
    () => filteredRows.reduce((sum, row) => sum + row.valueUsd, 0),
    [filteredRows],
  );
  const pnlValue = parseAmount(profile?.summary.realizedPnlBnb);
  const showTradePnl = hasClosedTradePnl(profile);
  const pnlClassName =
    !showTradePnl || pnlValue === null || pnlValue === 0
      ? "text-muted"
      : pnlValue > 0
        ? "text-ok"
        : "text-danger";
  const maxPnl = useMemo(
    () => maxAbsTokenPnl(filteredRows, profile),
    [filteredRows, profile],
  );
  const tabs: Array<{
    id: WalletRailTab;
    label: string;
    count: number;
    icon: LucideIcon;
  }> = [
    {
      id: "tokens",
      label: "Tokens",
      count: filteredRows.length,
      icon: Wallet,
    },
    { id: "defi", label: "DeFi", count: positions.length, icon: Layers3 },
    { id: "nfts", label: "NFTs", count: nfts.length, icon: ImageIcon },
    {
      id: "activity",
      label: "Activity",
      count: profile?.recentSwaps.length ?? 0,
      icon: Activity,
    },
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
  const collapseFooter = isDesktopSidebar ? (
    <button
      type="button"
      onClick={() => handleSidebarCollapsedChange(true)}
      aria-label="Collapse wallet sidebar"
      data-testid="wallets-sidebar-collapse-inline"
      className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-muted transition-colors hover:bg-bg-muted/60 hover:text-txt"
    >
      <ChevronsLeft className="h-4 w-4" aria-hidden />
    </button>
  ) : undefined;
  const headerContent = (
    <div className="space-y-5">
      <div>
        <div className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted">
          Balance
        </div>
        <div className="mt-2 font-mono text-[2.35rem] font-semibold leading-none text-txt">
          {formatUsd(totalUsd)}
        </div>
        <div className={cn("mt-2 text-sm font-semibold", pnlClassName)}>
          {showTradePnl && pnlValue !== null ? (
            <>
              {pnlValue > 0 ? "+" : ""}
              {formatBnb(profile?.summary.realizedPnlBnb)}
            </>
          ) : (
            `${filteredRows.length} visible tokens`
          )}
        </div>
      </div>

      {filteredRows.length > 0 ? (
        <AssetAllocationStrip rows={filteredRows} />
      ) : null}

      <div className="grid grid-cols-4 gap-2">
        <WalletRailActionButton
          icon={DollarSign}
          label="Buy"
          onClick={() => onWalletAction("buy")}
        />
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

      <div className="flex items-center gap-4 overflow-x-auto text-sm font-semibold">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 border-b-2 pb-2 transition-colors",
              activeTab === tab.id
                ? "border-accent text-txt"
                : "border-transparent text-muted hover:text-txt",
            )}
            onClick={() => setActiveTab(tab.id)}
          >
            <tab.icon className="h-3.5 w-3.5" />
            {tab.label}
            {tab.count > 0 ? (
              <span className="ml-1 font-mono text-xs text-muted">
                {tab.count}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {activeTab === "tokens" ? (
        <label className="flex h-10 items-center gap-2 rounded-full bg-bg/55 px-3 text-sm text-muted">
          <Search className="h-4 w-4 shrink-0" />
          <input
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search tokens"
            aria-label="Search tokens"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-txt outline-none placeholder:text-muted/70"
          />
        </label>
      ) : null}
    </div>
  );

  return (
    <Sidebar
      testId="wallets-sidebar"
      className="!mt-0 !h-full !bg-none !bg-transparent !rounded-none !border-0 !border-r !border-r-border/30 !shadow-none !backdrop-blur-none !ring-0"
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
      header={undefined}
      headerClassName="!h-0 !min-h-0 !p-0 !m-0 !overflow-hidden"
      footer={collapseFooter}
      footerClassName="!justify-start !px-1 !pb-2 !pt-1"
      collapseButtonClassName="!bottom-3 !left-3"
      expandButtonTestId="wallets-sidebar-expand-toggle"
      expandButtonAriaLabel="Expand wallet sidebar"
      mobileTitle="Wallet"
      mobileMeta={`${filteredRows.length} tokens`}
    >
      <div className="shrink-0 px-4 pb-3 pt-3">
        <WalletRailAccount addresses={addresses} />
        <div className="mt-4">{headerContent}</div>
      </div>
      <SidebarScrollRegion className="pt-0">
        <SidebarPanel className="space-y-1">
          {activeTab === "tokens" ? (
            filteredRows.length === 0 ? (
              <WalletRailEmpty
                icon={Wallet}
                title="No tokens"
                body="Balances will show here."
              />
            ) : (
              filteredRows.map((row) => (
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
          ) : (
            <RailActivityList profile={profile} />
          )}
        </SidebarPanel>
      </SidebarScrollRegion>
    </Sidebar>
  );
}

function RpcStatusCard({
  walletConfig,
  onOpenSettings,
}: {
  walletConfig: WalletConfigStatus | null;
  onOpenSettings: () => void;
}) {
  const rpcGood = Boolean(
    walletConfig?.evmBalanceReady && walletConfig?.solanaBalanceReady,
  );
  const rpcStateLabel = !walletConfig
    ? "Checking"
    : rpcGood
      ? "Good"
      : "Needs attention";
  const evmProvider = walletConfig
    ? providerLabel(walletConfig.selectedRpcProviders?.evm, "evm")
    : "—";
  const solanaProvider = walletConfig
    ? providerLabel(walletConfig.selectedRpcProviders?.solana, "solana")
    : "—";

  return (
    <button
      type="button"
      data-testid="wallet-rpc-dashboard-link"
      className="group rounded-2xl bg-bg/35 p-3 text-left transition-colors hover:bg-bg/55"
      onClick={onOpenSettings}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[0.68rem] uppercase tracking-[0.08em] text-muted">
            RPC
          </div>
          <div className="mt-1 flex items-center gap-2 text-sm font-semibold text-txt">
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                !walletConfig ? "bg-muted" : rpcGood ? "bg-ok" : "bg-warn",
              )}
            />
            {rpcStateLabel}
          </div>
        </div>
        <Settings className="h-4 w-4 text-muted transition-colors group-hover:text-accent" />
      </div>
      <div className="mt-3 grid gap-2 text-xs-tight text-muted sm:grid-cols-2">
        <div>
          <span className="font-medium text-txt">EVM</span> {evmProvider}
        </div>
        <div>
          <span className="font-medium text-txt">Solana</span> {solanaProvider}
        </div>
      </div>
    </button>
  );
}

function ActivityList({
  profile,
}: {
  profile: WalletTradingProfileResponse | null;
}) {
  const recent = profile?.recentSwaps ?? [];

  if (recent.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title="No trade activity"
        body="Settled trades will show here."
      />
    );
  }

  return (
    <div className="space-y-2">
      {recent.slice(0, 6).map((swap) => (
        <a
          key={swap.hash}
          href={swap.explorerUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-between gap-3 rounded-2xl bg-bg/35 px-3 py-2.5 text-sm transition-colors hover:bg-bg/55"
        >
          <span className="min-w-0">
            <span className="block truncate font-medium text-txt">
              {swap.side === "buy" ? "Bought" : "Sold"} {swap.tokenSymbol}
            </span>
            <span className="block truncate text-xs-tight text-muted">
              {swap.inputAmount} {swap.inputSymbol} {"->"} {swap.outputAmount}{" "}
              {swap.outputSymbol}
            </span>
          </span>
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-1 text-[0.65rem] uppercase",
              swap.status === "success"
                ? "bg-ok/10 text-ok"
                : swap.status === "pending"
                  ? "bg-warn/10 text-warn"
                  : "bg-danger/10 text-danger",
            )}
          >
            {swap.status}
          </span>
        </a>
      ))}
    </div>
  );
}

function NftPreview({ nfts }: { nfts: NftItem[] }) {
  const visible = nfts.slice(0, 6);

  if (visible.length === 0) {
    return (
      <EmptyState
        icon={ImageIcon}
        title="No NFTs"
        body="Collections will show here."
      />
    );
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
    return (
      <EmptyState
        icon={Layers3}
        title="No LP positions"
        body="LPs and vaults will show here."
      />
    );
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

function VincentPanel({
  connected,
  busy,
  error,
  onConnect,
  onOpen,
}: {
  connected: boolean;
  busy: boolean;
  error: string | null;
  onConnect: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="rounded-3xl bg-bg/35 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-txt">
            <Sparkles className="h-4 w-4 text-accent" />
            Vincent trading
          </div>
          <div className="mt-1 max-w-xl text-xs-tight text-muted">
            Hyperliquid + Polymarket
          </div>
        </div>
        <div className="flex gap-2">
          {connected ? (
            <Button variant="outline" size="sm" onClick={onOpen}>
              Open Vincent
            </Button>
          ) : (
            <Button size="sm" onClick={onConnect} disabled={busy}>
              {busy ? "Connecting" : "Connect Vincent"}
            </Button>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs-tight text-muted">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            connected ? "bg-ok" : "bg-muted",
          )}
        />
        {connected ? "Connected" : "Not connected"}
      </div>
      {error ? (
        <div className="mt-2 text-xs-tight text-danger">{error}</div>
      ) : null}
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
    vincentConnected,
    vincentLoginBusy,
    vincentLoginError,
    handleVincentLogin,
  } = useApp();

  const [searchQuery, setSearchQuery] = useState("");
  const [hiddenTokenIds, setHiddenTokenIds] = useState<Set<string>>(() =>
    readHiddenTokenIds(),
  );
  const [dashboardWindow, setDashboardWindow] =
    useState<DashboardWindow>("30d");
  const [tradingProfile, setTradingProfile] =
    useState<WalletTradingProfileResponse | null>(null);
  const [tradingProfileError, setTradingProfileError] = useState<string | null>(
    null,
  );
  const initialLoadRef = useRef(false);

  useEffect(() => {
    if (initialLoadRef.current) return;
    initialLoadRef.current = true;
    void loadWalletConfig();
    if (walletEnabled === false) return;
    void loadBalances();
    void loadNfts();
  }, [loadBalances, loadNfts, loadWalletConfig, walletEnabled]);

  useEffect(() => {
    let cancelled = false;
    setTradingProfileError(null);
    void client
      .getWalletTradingProfile(tradingProfileWindow(dashboardWindow))
      .then((profile) => {
        if (!cancelled) setTradingProfile(profile);
      })
      .catch((cause) => {
        if (cancelled) return;
        setTradingProfile(null);
        const message =
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : "Failed to load trading profile.";
        setTradingProfileError(message);
      });
    return () => {
      cancelled = true;
    };
  }, [dashboardWindow]);

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

  const hiddenCount = useMemo(
    () =>
      visibleAssetRows.filter((row) => hiddenTokenIds.has(tokenId(row))).length,
    [hiddenTokenIds, visibleAssetRows],
  );
  const displayedAssetRows = useMemo(
    () => visibleAssetRows.filter((row) => !hiddenTokenIds.has(tokenId(row))),
    [hiddenTokenIds, visibleAssetRows],
  );
  const displayedTotalUsd = useMemo(
    () => displayedAssetRows.reduce((sum, row) => sum + row.valueUsd, 0),
    [displayedAssetRows],
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
  const pnlTone =
    !showTradePnl || pnlValue === null || pnlValue === 0
      ? "text-muted"
      : pnlValue > 0
        ? "text-ok"
        : "text-danger";

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
  }, [loadBalances, loadNfts, loadWalletConfig]);

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
    (action: "buy" | "swap" | "send" | "receive") => {
      const prompt =
        action === "buy"
          ? "Prepare a token buy. Ask me for the token, amount, funding asset, slippage, and execution venue before any transaction."
          : action === "swap"
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
    if (typeof window !== "undefined") {
      window.location.hash = "wallet-rpc";
    }
    setTab("settings");
  }, [setTab]);

  const handleEnableWallet = useCallback(() => {
    setState("walletEnabled", true);
    void loadWalletConfig();
    void loadBalances();
    void loadNfts();
  }, [loadBalances, loadNfts, loadWalletConfig, setState]);

  const handleOpenVincent = useCallback(() => {
    setState("activeOverlayApp", VINCENT_APP_NAME);
  }, [setState]);

  const handleConnectVincent = useCallback(() => {
    void handleVincentLogin();
  }, [handleVincentLogin]);

  const tokenSidebar = (
    <TokenRail
      rows={visibleAssetRows}
      nfts={inventoryData.allNfts}
      positions={lpPositions}
      addresses={addresses}
      hiddenTokenIds={hiddenTokenIds}
      searchQuery={searchQuery}
      profile={tradingProfile}
      onSearchChange={setSearchQuery}
      onHideToken={handleHideToken}
      onTokenAction={handleTokenAction}
      onWalletAction={handleWalletAction}
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
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
              <Wallet className="h-4 w-4" />
              Wallet
            </div>
            <h1 className="mt-1 text-3xl font-semibold tracking-normal text-txt">
              Dashboard
            </h1>
            <div className="mt-1 text-sm text-muted">
              {displayedAssetRows.length} tokens, {inventoryData.allNfts.length}{" "}
              NFTs
              {hiddenCount > 0 ? `, ${hiddenCount} hidden` : ""}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="rounded-full"
              onClick={handleRefresh}
              disabled={walletLoading || walletNftsLoading}
            >
              <RefreshCw
                className={cn(
                  "mr-2 h-4 w-4",
                  (walletLoading || walletNftsLoading) && "animate-spin",
                )}
              />
              Refresh
            </Button>
            {walletEnabled === false ? (
              <Button className="rounded-full" onClick={handleEnableWallet}>
                Enable wallet
              </Button>
            ) : null}
          </div>
        </header>

        {walletError ? (
          <div className="rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger">
            {walletError}
          </div>
        ) : null}

        <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.72fr)]">
          <div className="min-w-0">
            <div className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-muted">
              Current balance
            </div>
            <div className="mt-2 font-mono text-5xl font-semibold tracking-normal text-txt">
              {formatUsd(displayedTotalUsd)}
            </div>
            <div className={cn("mt-3 text-base font-semibold", pnlTone)}>
              {showTradePnl && pnlValue !== null ? (
                <>
                  {pnlValue > 0 ? "+" : ""}
                  {formatBnb(tradingProfile?.summary.realizedPnlBnb)}
                </>
              ) : (
                "—"
              )}
            </div>
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-3 xl:grid-cols-1">
            <StatCard
              label="Trade P&L"
              value={
                showTradePnl
                  ? formatBnb(tradingProfile?.summary.realizedPnlBnb)
                  : "—"
              }
              detail={`${tradingProfile?.summary.totalSwaps ?? 0} swaps`}
              tone={pnlTone}
            />
            <StatCard
              label="Settled"
              value={`${tradingProfile?.summary.successCount ?? 0}/${tradingProfile?.summary.settledCount ?? 0}`}
              detail={`${tradingProfile?.summary.buyCount ?? 0} buys • ${tradingProfile?.summary.sellCount ?? 0} sells`}
            />
            <StatCard
              label="Assets"
              value={String(displayedAssetRows.length)}
              detail={
                hiddenCount > 0
                  ? `${hiddenCount} hidden`
                  : `${inventoryData.allNfts.length} NFTs`
              }
            />
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <RpcStatusCard
            walletConfig={walletConfig}
            onOpenSettings={handleOpenRpcSettings}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <AddressPill label="EVM" address={addresses.evmAddress} />
            <AddressPill label="Solana" address={addresses.solanaAddress} />
          </div>
        </section>

        <div className="grid gap-8 xl:grid-cols-[minmax(0,1.22fr)_minmax(20rem,0.8fr)]">
          <div className="space-y-8">
            <section className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-txt">
                  <BarChart3 className="h-4 w-4 text-accent" />
                  Trade P&L
                </div>
                <div className="flex rounded-full bg-bg/35 p-1">
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
              </div>
              <PnlChart profile={tradingProfile} />
              {tradingProfileError ? (
                <div className="text-xs-tight text-danger">
                  {tradingProfileError}
                </div>
              ) : null}
            </section>

            <section className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-txt">
                <Activity className="h-4 w-4 text-accent" />
                Trade Activity
              </div>
              <ActivityList profile={tradingProfile} />
            </section>
          </div>

          <div className="space-y-8">
            <section className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-txt">
                <PieChart className="h-4 w-4 text-accent" />
                Portfolio
              </div>
              <WalletCompositionPanel rows={displayedAssetRows} />
            </section>

            <section className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-txt">
                <TrendingUp className="h-4 w-4 text-accent" />
                Trade Movers
              </div>
              <PortfolioMoversPanel
                rows={displayedAssetRows}
                profile={tradingProfile}
              />
            </section>

            <section className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-txt">
                <Layers3 className="h-4 w-4 text-accent" />
                LP positions
              </div>
              <LpPositionsPanel positions={lpPositions} />
            </section>

            <section className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-txt">
                <ImageIcon className="h-4 w-4 text-accent" />
                NFTs
              </div>
              <NftPreview nfts={inventoryData.allNfts} />
            </section>

            <VincentPanel
              connected={vincentConnected}
              busy={vincentLoginBusy}
              error={vincentLoginError}
              onConnect={handleConnectVincent}
              onOpen={handleOpenVincent}
            />
          </div>
        </div>
      </div>
    </PageLayout>
  );
}
