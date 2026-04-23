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
  PagePanel,
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarPanel,
  SidebarScrollRegion,
} from "@elizaos/ui";
import {
  Activity,
  ArrowLeftRight,
  BarChart3,
  Copy,
  EyeOff,
  Image as ImageIcon,
  Layers3,
  type LucideIcon,
  PieChart,
  RefreshCw,
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
import { WidgetHost } from "../../widgets";
import {
  formatBalance,
  type NftItem,
  type TokenRow,
} from "../inventory/constants";
import { TokenLogo } from "../inventory/TokenLogo";
import { useInventoryData } from "../inventory/useInventoryData";

type DashboardWindow = "24h" | "7d" | "30d";

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
const VINCENT_APP_NAME = "@elizaos/app-vincent";

interface InventoryPositionAsset {
  id: string;
  kind: "token" | "nft";
  label: string;
  detail: string;
  valueUsd: number | null;
  imageUrl: string | null;
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

function shortAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

function providerLabel(provider: string | null | undefined): string {
  switch (provider) {
    case "eliza-cloud":
      return "Eliza Cloud";
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

function TokenPerformance({
  row,
  profile,
  maxAbsPnl,
}: {
  row: TokenRow;
  profile: WalletTradingProfileResponse | null;
  maxAbsPnl: number;
}) {
  const normalizedAddress = normalizeTokenAddress(row.contractAddress);
  const breakdown =
    normalizedAddress && profile
      ? profile.tokenBreakdown.find(
          (item) => item.tokenAddress.toLowerCase() === normalizedAddress,
        )
      : null;

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
    const normalizedAddress = normalizeTokenAddress(row.contractAddress);
    if (!normalizedAddress) continue;
    const breakdown = profile.tokenBreakdown.find(
      (item) => item.tokenAddress.toLowerCase() === normalizedAddress,
    );
    const pnl = parseAmount(breakdown?.realizedPnlBnb);
    if (pnl !== null) max = Math.max(max, Math.abs(pnl));
  }
  return max;
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
        body="No indexed token balances."
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
            className="flex min-w-0 items-center gap-3 rounded-lg border border-border/50 bg-bg/40 p-3"
          >
            <TokenLogo
              symbol={row.symbol}
              chain={row.chain}
              contractAddress={row.contractAddress}
              preferredLogoUrl={row.logoUrl}
              size={34}
            />
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

function AddressPill({ label, address }: { label: string; address: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [address]);

  return (
    <Button
      variant="outline"
      className="min-w-0 justify-between gap-2 rounded-lg px-3 py-2 text-left"
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
    <div className="flex min-h-[8rem] flex-col items-center justify-center rounded-lg border border-dashed border-border/60 bg-bg/40 px-4 py-6 text-center">
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
      <div className="flex h-24 items-center justify-center rounded-lg border border-border/40 bg-bg/30 text-xs text-muted">
        No P&L series yet
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
      className="h-24 w-full rounded-lg border border-border/40 bg-bg/30"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-label="Agent P&L chart"
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
    <div className="rounded-lg border border-border/50 bg-bg/40 p-3">
      <div className="text-[0.68rem] uppercase tracking-[0.08em] text-muted">
        {label}
      </div>
      <div className={cn("mt-1 text-lg font-semibold", tone)}>{value}</div>
      {detail ? (
        <div className="mt-1 text-xs-tight text-muted">{detail}</div>
      ) : null}
    </div>
  );
}

function TokenRail({
  rows,
  hiddenTokenIds,
  searchQuery,
  profile,
  onSearchChange,
  onHideToken,
  onTokenAction,
}: {
  rows: TokenRow[];
  hiddenTokenIds: Set<string>;
  searchQuery: string;
  profile: WalletTradingProfileResponse | null;
  onSearchChange: (value: string) => void;
  onHideToken: (row: TokenRow) => void;
  onTokenAction: (row: TokenRow, action: "swap" | "bridge") => void;
}) {
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
  const maxPnl = useMemo(
    () => maxAbsTokenPnl(filteredRows, profile),
    [filteredRows, profile],
  );

  return (
    <Sidebar
      testId="wallet-token-sidebar"
      collapsible
      contentIdentity="wallet-tokens"
      collapseButtonTestId="wallet-token-sidebar-collapse-toggle"
      expandButtonTestId="wallet-token-sidebar-expand-toggle"
      collapseButtonAriaLabel="Collapse tokens"
      expandButtonAriaLabel="Expand tokens"
      mobileTitle="Tokens"
      mobileMeta={`${filteredRows.length} visible`}
      header={
        <SidebarHeader
          search={{
            value: searchQuery,
            onChange: (event) => onSearchChange(event.target.value),
            onClear: () => onSearchChange(""),
            placeholder: "Search tokens",
            "aria-label": "Search tokens",
            autoComplete: "off",
            spellCheck: false,
          }}
        >
          <div className="space-y-3 px-1">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                  Assets
                </div>
                <div className="mt-1 text-2xl font-semibold text-txt">
                  {formatUsd(totalUsd)}
                </div>
              </div>
              <div className="flex h-11 w-11 items-center justify-center rounded-full border border-border/50 bg-bg/45">
                <Wallet className="h-5 w-5 text-accent" />
              </div>
            </div>
            <AssetAllocationStrip rows={filteredRows} />
          </div>
        </SidebarHeader>
      }
    >
      <SidebarScrollRegion>
        <SidebarPanel className="space-y-2">
          {filteredRows.length === 0 ? (
            <SidebarContent.EmptyState className="px-4 py-8 text-center">
              <Wallet className="mx-auto mb-3 h-5 w-5 text-muted" />
              <div className="text-sm font-semibold text-txt">
                No tokens found
              </div>
              <div className="mt-1 text-xs-tight text-muted">
                No visible tokens in this wallet.
              </div>
            </SidebarContent.EmptyState>
          ) : (
            filteredRows.map((row) => (
              <div
                key={tokenId(row)}
                className="group rounded-xl border border-border/45 bg-card/55 p-3 shadow-sm transition-colors hover:border-accent/35 hover:bg-card/80"
              >
                <div className="flex items-center gap-3">
                  <TokenLogo
                    symbol={row.symbol}
                    chain={row.chain}
                    contractAddress={row.contractAddress}
                    preferredLogoUrl={row.logoUrl}
                    size={42}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-base font-semibold text-txt">
                          {row.symbol}
                        </div>
                        <div className="truncate text-xs-tight text-muted">
                          {formatBalance(row.balance)}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="font-mono text-sm font-semibold text-txt">
                          {formatUsd(row.valueUsd)}
                        </div>
                        <TokenPerformance
                          row={row}
                          profile={profile}
                          maxAbsPnl={maxPnl}
                        />
                      </div>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <div className="min-w-0 truncate text-[0.68rem] text-muted">
                        {row.name}
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-8 w-8 rounded-full"
                          onClick={() => onTokenAction(row, "swap")}
                          aria-label={`Swap ${row.symbol}`}
                          title={`Swap ${row.symbol}`}
                        >
                          <ArrowLeftRight className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-8 w-8 rounded-full"
                          onClick={() => onTokenAction(row, "bridge")}
                          aria-label={`Bridge ${row.symbol}`}
                          title={`Bridge ${row.symbol}`}
                        >
                          <Layers3 className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 rounded-full text-muted hover:text-danger"
                          onClick={() => onHideToken(row)}
                          aria-label={`Hide ${row.symbol}`}
                          title={`Hide ${row.symbol}`}
                        >
                          <EyeOff className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))
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
  const evmProvider = providerLabel(walletConfig?.selectedRpcProviders?.evm);
  const solanaProvider = providerLabel(
    walletConfig?.selectedRpcProviders?.solana,
  );

  return (
    <button
      type="button"
      data-testid="wallet-rpc-dashboard-link"
      className="group rounded-lg border border-border/50 bg-bg/40 p-4 text-left transition-colors hover:border-accent/60 hover:bg-accent/5"
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
                rpcGood ? "bg-ok" : "bg-warn",
              )}
            />
            {rpcGood ? "Good" : "Needs attention"}
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
        title="No wallet activity yet"
        body="No settled wallet actions."
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
          className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-bg/40 px-3 py-2.5 text-sm transition-colors hover:border-accent/50"
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
        title="No NFTs detected"
        body="No indexed NFT collections."
      />
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      {visible.map((nft) => (
        <div
          key={`${nft.chain}:${nft.collectionName}:${nft.name}:${nft.imageUrl}`}
          className="overflow-hidden rounded-lg border border-border/50 bg-bg/40"
        >
          {nft.imageUrl ? (
            <img
              src={nft.imageUrl}
              alt={nft.name}
              className="aspect-square w-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex aspect-square items-center justify-center bg-bg-muted">
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
        title="No LP assets detected"
        body="No indexed LP tokens or position NFTs."
      />
    );
  }

  return (
    <div className="grid gap-2">
      {positions.map((position) => (
        <div
          key={position.id}
          className="flex min-w-0 items-center gap-3 rounded-lg border border-border/50 bg-bg/40 p-3"
        >
          {position.imageUrl ? (
            <img
              src={position.imageUrl}
              alt={position.label}
              className="h-10 w-10 shrink-0 rounded-lg object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-bg-muted">
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
    <div className="rounded-lg border border-border/50 bg-bg/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-txt">
            <Sparkles className="h-4 w-4 text-accent" />
            Vincent trading
          </div>
          <div className="mt-1 max-w-xl text-xs-tight text-muted">
            Connect Vincent to trade on Hyperliquid and Polymarket through the
            Vincent agent.
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
        {connected ? "Connected to Vincent" : "Not connected"}
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
    if (walletEnabled === false) return;
    void loadBalances();
    void loadNfts();
  }, [loadBalances, loadNfts, walletEnabled]);

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
  const pnlTone =
    pnlValue === null || pnlValue === 0
      ? "text-txt"
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
    void loadBalances();
    void loadNfts();
  }, [loadBalances, loadNfts]);

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

  const handleOpenRpcSettings = useCallback(() => {
    if (typeof window !== "undefined") {
      window.location.hash = "wallet-rpc";
    }
    setTab("settings");
  }, [setTab]);

  const handleEnableWallet = useCallback(() => {
    setState("walletEnabled", true);
    void loadBalances();
    void loadNfts();
  }, [loadBalances, loadNfts, setState]);

  const handleOpenVincent = useCallback(() => {
    setState("activeOverlayApp", VINCENT_APP_NAME);
  }, [setState]);

  const handleConnectVincent = useCallback(() => {
    void handleVincentLogin();
  }, [handleVincentLogin]);

  const tokenSidebar = (
    <TokenRail
      rows={visibleAssetRows}
      hiddenTokenIds={hiddenTokenIds}
      searchQuery={searchQuery}
      profile={tradingProfile}
      onSearchChange={setSearchQuery}
      onHideToken={handleHideToken}
      onTokenAction={handleTokenAction}
    />
  );

  return (
    <PageLayout
      className="h-full"
      data-testid="wallet-shell"
      sidebar={tokenSidebar}
      footer={<WidgetHost slot="wallet" />}
      footerClassName="pt-2"
      contentClassName="bg-bg/10"
      contentInnerClassName="w-full min-h-0"
      mobileSidebarLabel="Tokens"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
              <Wallet className="h-4 w-4" />
              Wallet
            </div>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal text-txt">
              Agent wallet dashboard
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
              className="rounded-lg"
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
              <Button className="rounded-lg" onClick={handleEnableWallet}>
                Enable wallet
              </Button>
            ) : null}
          </div>
        </div>

        {walletError ? (
          <div className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            {walletError}
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-3">
          <StatCard
            label="Current balance"
            value={formatUsd(displayedTotalUsd)}
            detail={`${displayedAssetRows.length} visible tokens`}
          />
          <StatCard
            label="Agent P&L"
            value={formatBnb(tradingProfile?.summary.realizedPnlBnb)}
            detail={`${tradingProfile?.summary.totalSwaps ?? 0} swaps`}
            tone={pnlTone}
          />
          <StatCard
            label="Agent activity"
            value={`${tradingProfile?.summary.successCount ?? 0}/${tradingProfile?.summary.settledCount ?? 0}`}
            detail={`${tradingProfile?.summary.settledCount ?? 0} settled`}
          />
        </div>

        <PagePanel variant="section">
          <div className="p-4 sm:p-5">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-txt">
              <PieChart className="h-4 w-4 text-accent" />
              Wallet composition
            </div>
            <WalletCompositionPanel rows={displayedAssetRows} />
          </div>
        </PagePanel>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(22rem,0.8fr)]">
          <div className="space-y-4">
            <PagePanel variant="section">
              <div className="p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold text-txt">
                      <BarChart3 className="h-4 w-4 text-accent" />
                      Agent P&L
                    </div>
                    <div className="mt-1 text-xs-tight text-muted">
                      Realized trade performance from the wallet ledger.
                    </div>
                  </div>
                  <div className="flex rounded-lg border border-border/60 bg-bg/40 p-1">
                    {DASHBOARD_WINDOWS.map((window) => (
                      <button
                        key={window}
                        type="button"
                        className={cn(
                          "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
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
                <div className="mt-4">
                  <PnlChart profile={tradingProfile} />
                </div>
                {tradingProfileError ? (
                  <div className="mt-3 text-xs-tight text-danger">
                    {tradingProfileError}
                  </div>
                ) : null}
              </div>
            </PagePanel>

            <PagePanel variant="section">
              <div className="p-4 sm:p-5">
                <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-txt">
                  <Activity className="h-4 w-4 text-accent" />
                  Agent activity
                </div>
                <ActivityList profile={tradingProfile} />
              </div>
            </PagePanel>

            <PagePanel variant="section">
              <div className="p-4 sm:p-5">
                <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-txt">
                  <ImageIcon className="h-4 w-4 text-accent" />
                  NFTs
                </div>
                <NftPreview nfts={inventoryData.allNfts} />
              </div>
            </PagePanel>
          </div>

          <div className="space-y-4">
            <RpcStatusCard
              walletConfig={walletConfig}
              onOpenSettings={handleOpenRpcSettings}
            />

            <PagePanel variant="section">
              <div className="space-y-3 p-4 sm:p-5">
                <div className="text-sm font-semibold text-txt">Addresses</div>
                {addresses.evmAddress || addresses.solanaAddress ? (
                  <div className="grid gap-2">
                    {addresses.evmAddress ? (
                      <AddressPill label="EVM" address={addresses.evmAddress} />
                    ) : null}
                    {addresses.solanaAddress ? (
                      <AddressPill
                        label="Solana"
                        address={addresses.solanaAddress}
                      />
                    ) : null}
                  </div>
                ) : (
                  <EmptyState
                    icon={Wallet}
                    title="No wallet addresses"
                    body="Configure the agent wallet to show EVM and Solana addresses here."
                  />
                )}
              </div>
            </PagePanel>

            <PagePanel variant="section">
              <div className="p-4 sm:p-5">
                <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-txt">
                  <Layers3 className="h-4 w-4 text-accent" />
                  LP positions
                </div>
                <LpPositionsPanel positions={lpPositions} />
              </div>
            </PagePanel>

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
