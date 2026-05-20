"use client";

import {
  calculateExpectedPayout,
  PredictionPricing,
} from "@feed/core/markets/prediction/client";
import { FEE_CONFIG } from "@feed/engine/config/fees";
import { cn, FEED_POINTS_SYMBOL, formatCompactNumber } from "@feed/shared";
import {
  ArrowLeft,
  ArrowUpDown,
  Check,
  Info,
  Maximize2,
  Minimize2,
  Search,
  Wallet,
  X,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { toast } from "sonner";
import { AssetTradesFeed } from "@/components/markets/AssetTradesFeed";
import { PerpPositionsList } from "@/components/markets/PerpPositionsList";
import { PerpPriceChart } from "@/components/markets/PerpPriceChart";
import { PredictionPositionsList } from "@/components/markets/PredictionPositionsList";
import { PredictionProbabilityChart } from "@/components/markets/PredictionProbabilityChart";
import {
  type BuyPredictionDetails,
  type SellPredictionDetails,
  TradeConfirmationDialog,
} from "@/components/markets/TradeConfirmationDialog";
import { Skeleton } from "@/components/shared/Skeleton";
import { SpotlightTutorial } from "@/components/tutorial/SpotlightTutorial";
import { TutorialHelpButton } from "@/components/tutorial/TutorialHelpButton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/hooks/useAuth";
import { usePerpHistory } from "@/hooks/usePerpHistory";
import { usePortfolioPnL } from "@/hooks/usePortfolioPnL";
import { usePredictionHistory } from "@/hooks/usePredictionHistory";
import type {
  PredictionResolutionSSE,
  PredictionTradeSSE,
} from "@/hooks/usePredictionMarketStream";
import { usePredictionMarketStream } from "@/hooks/usePredictionMarketStream";
import { formatBalance } from "@/lib/market-formatters";
import {
  type MarketKey,
  useMarketWatchlistStore,
} from "@/stores/marketWatchlistStore";
import {
  usePerpMarkets,
  usePerpMarketsRealtime,
} from "@/stores/perpMarketsStore";
import {
  usePredictionMarkets,
  usePredictionMarketsPolling,
} from "@/stores/predictionMarketsStore";
import {
  invalidateUserPositions,
  usePerpPositions,
  usePredictionPositions,
  useUserPositionsPolling,
} from "@/stores/userPositionsStore";
import {
  invalidateWalletBalance,
  useWalletBalance,
  useWalletBalancePolling,
} from "@/stores/walletBalanceStore";
import type {
  MarketTimeRange,
  PerpMarket,
  PredictionMarket,
  TradeSide,
} from "@/types/markets";
import { MARKET_TIME_RANGES } from "@/types/markets";
import { MarketsDashboard } from "../dashboard/MarketsDashboard";
import { PerpsOrderEntryPanel } from "../perps-terminal/PerpsOrderEntryPanel";
import { useMarketsTutorial } from "../tutorial/useMarketsTutorial";
import {
  buildPredictionLiveStateFromResolution,
  buildPredictionLiveStateFromTrade,
  buildPredictionTerminalState,
  isSamePredictionLiveState,
  type PredictionMarketLiveState,
  type PredictionMarketTerminalState,
} from "./predictionTerminalState";
import { TerminalAgentsChat } from "./TerminalAgentsChat";
import { TerminalPortfolio } from "./TerminalPortfolio";
import { TerminalSocialFeed } from "./TerminalSocialFeed";

type MarketsFilter = "all" | "favorites" | "perp" | "prediction";
type MarketsSort = "volume" | "change" | "openInterest" | "name";
type ContentTab = "chart" | "agents" | "social" | "trades";
type BottomTab = "agent" | "social" | "portfolio" | "positions" | "trades";
type MobileTab = "chart" | BottomTab;

/** Minimum shares threshold for sellable positions */
const MIN_SELLABLE_SHARES = 0.01;

/** Cooldown period between portfolio refreshes to prevent API spam (ms) */
const REFRESH_COOLDOWN_MS = 5000;

/**
 * Labels for each bottom tab - used for dynamic mobile panel title and accessibility.
 * Centralizing these ensures consistency between button labels and panel headers.
 */
const BOTTOM_TAB_LABELS: Record<BottomTab, string> = {
  agent: "Agents",
  social: "Social",
  portfolio: "Portfolio",
  positions: "Positions",
  trades: "Trades",
};

const MOBILE_TAB_LABELS: Record<MobileTab, string> = {
  chart: "Chart",
  ...BOTTOM_TAB_LABELS,
};

const MOBILE_TABS: readonly MobileTab[] = [
  "chart",
  "agent",
  "social",
  "portfolio",
  "positions",
  "trades",
];

function MobileTabBar({
  activeTab,
  onSelect,
}: {
  activeTab: MobileTab;
  onSelect: (tab: MobileTab) => void;
}) {
  return (
    <div className="hide-scrollbar min-w-0 flex-1 overflow-x-auto">
      <div className="flex w-max min-w-full items-center justify-center gap-1 px-1">
        {MOBILE_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => onSelect(tab)}
            className={cn(
              "relative flex h-9 shrink-0 items-center justify-center rounded-xl px-3 font-bold text-[11px] transition-colors duration-200",
              activeTab === tab
                ? "bg-muted/20 text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            aria-current={activeTab === tab ? "page" : undefined}
          >
            {MOBILE_TAB_LABELS[tab]}
            <div
              className={cn(
                "absolute right-2 bottom-0 left-2 h-0.5 origin-center rounded-full bg-foreground transition-transform duration-200",
                activeTab === tab ? "scale-x-100" : "scale-x-0",
              )}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

/*
 * Z-INDEX STACKING CONTEXT (documentation only - Tailwind requires static class names)
 * ─────────────────────────────────────────────────────────────────────────────────────
 * z-40:   Mobile bottom dock bar
 * z-[70]: Mobile panel overlay (above dock), trade sheet, market list
 * z-[80]: Modal dialogs and fullscreen chart overlay
 */

interface MarketsTradingTerminalProps {
  onRequestBuyPoints?: () => void;
}

interface UnifiedRow {
  key: MarketKey;
  kind: "perp" | "prediction";
  title: string;
  subtitle: string;
  valuePrimary: string;
  valueSecondary?: string;
  change24hPct?: number | null;
  sortVolume: number;
  sortOpenInterest: number;
  sortName: string;
  /** Perp org logo URL when `kind === 'perp'`. */
  perpImageUrl?: string | null;
  perpMarket?: PerpMarket;
  predictionMarket?: PredictionMarket;
}

function parseFilter(params: URLSearchParams): MarketsFilter {
  const filter = params.get("filter");
  if (
    filter === "perp" ||
    filter === "prediction" ||
    filter === "favorites" ||
    filter === "all"
  ) {
    return filter;
  }
  const tab = params.get("tab") ?? params.get("tabs");
  if (tab === "perps") return "perp";
  if (tab === "predictions") return "prediction";
  return "all";
}

function parseSort(params: URLSearchParams): MarketsSort {
  const sort = params.get("sort");
  if (
    sort === "volume" ||
    sort === "change" ||
    sort === "openInterest" ||
    sort === "name"
  ) {
    return sort;
  }
  return "volume";
}

function parseSortDesc(params: URLSearchParams): boolean {
  const dir = params.get("sortDir");
  if (dir === "asc") return false;
  if (dir === "desc") return true;
  return true;
}

function parseSelected(params: URLSearchParams): MarketKey | null {
  const kind = params.get("marketKind");
  const id = params.get("marketId");
  if (!kind || !id) return null;
  if (kind !== "perp" && kind !== "prediction") return null;
  return { kind, id };
}

function parsePerpSide(params: URLSearchParams): TradeSide | null {
  const side = params.get("side");
  if (side === "long" || side === "short") return side;
  return null;
}

function parsePredictionSide(params: URLSearchParams): "yes" | "no" | null {
  const side = params.get("side");
  if (side === "yes" || side === "no") return side;
  return null;
}

function formatYesPct(raw: number): string {
  const clamped = Math.min(100, Math.max(0, raw));
  const rounded =
    clamped >= 10 ? Math.round(clamped) : Math.round(clamped * 10) / 10;
  return `${rounded.toFixed(clamped >= 10 ? 0 : 1)}%`;
}

/** Strip legacy on-chain suffix so the UI shows the company name only. */
function perpCompanyLabel(name: string): string {
  return name.replace(/\s+Perpetual$/i, "").trim() || name;
}

function PerpOrgAvatar({
  imageUrl,
  label,
  size,
}: {
  imageUrl?: string | null;
  label: string;
  size: "sm" | "md" | "lg";
}) {
  const safeLabel = label.trim() || "?";
  const initial = safeLabel.slice(0, 1).toUpperCase();
  const shell = cn(
    "relative shrink-0 overflow-hidden rounded-xl bg-muted/50 ring-1 ring-white/10",
    size === "lg" && "h-14 w-14",
    size === "md" && "h-12 w-12",
    size === "sm" && "h-7 w-7",
  );
  const textClass =
    size === "lg"
      ? "font-bold text-foreground text-base"
      : size === "md"
        ? "font-bold text-foreground text-sm"
        : "font-bold text-[10px] text-foreground";

  if (imageUrl) {
    const dim = size === "lg" ? 56 : size === "md" ? 48 : 28;
    return (
      <Image
        src={imageUrl}
        alt=""
        width={dim}
        height={dim}
        className={cn(shell, "object-cover")}
      />
    );
  }

  return (
    <div className={cn(shell, "flex items-center justify-center")} aria-hidden>
      <span className={textClass}>{initial}</span>
    </div>
  );
}

function formatDate(dateStr: string | undefined | null): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function computeYesPctFromShares(
  market: PredictionMarketTerminalState,
): number {
  // Prefer CPMM-derived probability from SSE when available
  if (market.yesProbability != null) {
    return market.yesProbability * 100;
  }
  // Fallback to share-ratio calculation
  const yes = Number(market.yesShares ?? 0);
  const no = Number(market.noShares ?? 0);
  const total = yes + no;
  if (total <= 0) return 50;
  return (yes / total) * 100;
}

/** Reusable time range selector for market charts */
function TimeRangeSelector({
  timeRange,
  onTimeRangeChange,
}: {
  timeRange: MarketTimeRange;
  onTimeRangeChange: (range: MarketTimeRange) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md bg-muted/20 p-1 font-semibold text-xs">
      {MARKET_TIME_RANGES.map((range) => (
        <button
          key={range}
          type="button"
          onClick={() => onTimeRangeChange(range)}
          className={cn(
            "rounded px-2 py-1 transition-colors",
            timeRange === range
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {range}
        </button>
      ))}
    </div>
  );
}

/** Reusable prediction market header for mobile/desktop views */
function PredictionMarketHeader({
  predictionState,
  yesPct,
  timeRange,
  onTimeRangeChange,
  onDetailsClick,
  onFullscreen,
  variant = "default",
}: {
  predictionState: PredictionMarketTerminalState | null;
  yesPct: number;
  timeRange: MarketTimeRange;
  onTimeRangeChange: (range: MarketTimeRange) => void;
  onDetailsClick: () => void;
  onFullscreen?: () => void;
  variant?: "default" | "compact";
}) {
  const isCompact = variant === "compact";
  const titleClass = isCompact
    ? "whitespace-normal break-words font-bold text-sm leading-snug"
    : "whitespace-normal break-words font-bold text-foreground text-lg leading-snug";

  return (
    <div
      className={cn(
        "shrink-0 border-white/5 border-b bg-background/40 px-4 py-3 backdrop-blur-md",
        isCompact ? "space-y-2" : "",
      )}
    >
      <div
        className={cn(
          "flex gap-3",
          isCompact
            ? "items-start justify-between"
            : "flex-col lg:flex-row lg:items-start lg:justify-between",
        )}
      >
        <div className="min-w-0">
          <div className={titleClass}>
            {predictionState?.text ?? "Prediction market"}
          </div>
          <div className="mt-1 whitespace-normal break-words text-muted-foreground text-xs">
            {predictionState?.resolutionDescription?.trim()
              ? predictionState.resolutionDescription
              : `Scenario ${predictionState?.scenario ?? ""}`}
          </div>
        </div>
        {isCompact ? (
          <button
            type="button"
            onClick={onDetailsClick}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-white/10 bg-background/30 text-muted-foreground transition-colors hover:bg-muted/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            aria-label="View market details"
            title="Details"
          >
            <Info size={14} />
          </button>
        ) : null}
      </div>

      <div
        className={cn(
          "flex items-center gap-2",
          isCompact
            ? "flex-wrap justify-between"
            : "flex-col gap-2 lg:items-end",
        )}
      >
        <div className="flex items-center gap-2">
          <div className="rounded-full bg-blue-500/10 px-2 py-1 font-bold text-[10px] text-blue-400 tabular-nums">
            YES {formatYesPct(yesPct)}
          </div>
          <div className="rounded-full bg-violet-500/10 px-2 py-1 font-bold text-[10px] text-violet-400 tabular-nums">
            NO {formatYesPct(100 - yesPct)}
          </div>
          {!isCompact && (
            <button
              type="button"
              onClick={onDetailsClick}
              className="inline-flex h-8 w-8 items-center justify-center rounded border border-white/10 bg-background/30 text-muted-foreground transition-colors hover:bg-muted/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              aria-label="View market details"
              title="Details"
            >
              <Info size={14} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <TimeRangeSelector
            timeRange={timeRange}
            onTimeRangeChange={onTimeRangeChange}
          />
          {onFullscreen && (
            <button
              type="button"
              onClick={onFullscreen}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-white/10 bg-background/30 text-muted-foreground transition-colors hover:bg-muted/20 hover:text-foreground"
              aria-label="Open chart fullscreen"
              title="Fullscreen"
            >
              <Maximize2 size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Reusable perp market header for mobile/desktop views */
function PerpMarketHeader({
  selectedPerp,
  timeRange,
  onTimeRangeChange,
  onFullscreen,
  variant = "default",
}: {
  selectedPerp: PerpMarket;
  timeRange: MarketTimeRange;
  onTimeRangeChange: (range: MarketTimeRange) => void;
  onFullscreen?: () => void;
  variant?: "default" | "compact";
}) {
  const isCompact = variant === "compact";
  const titleClass = isCompact
    ? "font-bold text-foreground text-sm"
    : "font-bold text-foreground text-lg";

  return (
    <div className="flex shrink-0 items-start justify-between gap-3 border-white/5 border-b bg-background/40 px-4 py-3 backdrop-blur-md">
      <div className="flex min-w-0 items-center gap-3">
        <PerpOrgAvatar
          imageUrl={selectedPerp.imageUrl}
          label={selectedPerp.name || selectedPerp.ticker}
          size="lg"
        />
        <div className="min-w-0">
          <div className={titleClass}>${selectedPerp.ticker}</div>
          <div className="truncate text-muted-foreground text-xs">
            {perpCompanyLabel(selectedPerp.name)}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <TimeRangeSelector
          timeRange={timeRange}
          onTimeRangeChange={onTimeRangeChange}
        />
        {onFullscreen && (
          <button
            type="button"
            onClick={onFullscreen}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-white/10 bg-background/30 text-muted-foreground transition-colors hover:bg-muted/20 hover:text-foreground"
            aria-label="Open chart fullscreen"
            title="Fullscreen"
          >
            <Maximize2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

export function MarketsTradingTerminal({
  onRequestBuyPoints,
}: MarketsTradingTerminalProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const terminalRootRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const previousOverflowRef = useRef<{
    body: string;
    html: string;
  } | null>(null);

  const { user, authenticated, login, getAccessToken } = useAuth();
  const userId = authenticated ? (user?.id ?? null) : null;

  const {
    markets: perpMarkets,
    loading: perpLoading,
    error: perpError,
  } = usePerpMarkets();
  usePerpMarketsRealtime();

  const {
    markets: predictionMarkets,
    loading: predictionLoading,
    error: predictionError,
  } = usePredictionMarkets(userId ?? undefined);
  usePredictionMarketsPolling(30_000, userId ?? undefined);

  useUserPositionsPolling(userId);
  useWalletBalancePolling(userId);
  const {
    balance,
    loading: balanceLoading,
    refresh: refreshWalletBalance,
  } = useWalletBalance(userId);

  const { positions: perpPositions, refresh: refreshPerpPositions } =
    usePerpPositions(userId);
  const {
    positions: predictionPositions,
    refresh: refreshPredictionPositions,
  } = usePredictionPositions(userId);
  const {
    data: portfolioPnL,
    loading: portfolioLoading,
    error: portfolioError,
    refresh: refreshPortfolio,
  } = usePortfolioPnL();

  const [filter, setFilter] = useState<MarketsFilter>(() =>
    parseFilter(searchParams),
  );
  const [sortBy, setSortBy] = useState<MarketsSort>(() =>
    parseSort(searchParams),
  );
  const [sortDesc, setSortDesc] = useState(() => parseSortDesc(searchParams));
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<MarketKey | null>(() =>
    parseSelected(searchParams),
  );

  const [bottomTab, setBottomTab] = useState<BottomTab>("agent");
  const [contentTab, setContentTab] = useState<ContentTab>("chart");

  const [showMarketsMenu, setShowMarketsMenu] = useState(false);
  const marketsMenuRef = useRef<HTMLDivElement | null>(null);

  const [predictionSide, setPredictionSide] = useState<"yes" | "no">(
    () => parsePredictionSide(searchParams) ?? "yes",
  );
  const [predictionAmount, setPredictionAmount] = useState("10");
  const [predictionTradeMode, setPredictionTradeMode] = useState<
    "buy" | "sell"
  >("buy");
  const [predictionSellShares, setPredictionSellShares] = useState("");
  const [predictionSubmitting, setPredictionSubmitting] = useState(false);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [predictionDetailsOpen, setPredictionDetailsOpen] = useState(false);

  const [perpTimeRange, setPerpTimeRange] = useState<MarketTimeRange>("1D");
  const [predictionTimeRange, setPredictionTimeRange] =
    useState<MarketTimeRange>("ALL");
  const [perpSideFromUrl, setPerpSideFromUrl] = useState<TradeSide | null>(() =>
    parsePerpSide(searchParams),
  );

  // Mobile UI state
  const [isMobileMarketListOpen, setIsMobileMarketListOpen] = useState(false);
  const [isMobileTradeSheetOpen, setIsMobileTradeSheetOpen] = useState(false);
  const [isMobileChartFullscreen, setIsMobileChartFullscreen] = useState(false);
  const [isMobilePanelOpen, setIsMobilePanelOpen] = useState(false);
  const [mobileBottomNavHeight, setMobileBottomNavHeight] = useState(56);
  const [mobileChartAnimationKey, setMobileChartAnimationKey] = useState(0);

  // Tutorial
  const tutorial = useMarketsTutorial({
    onBeforeStart: () => {
      setIsMobilePanelOpen(false);
      setIsMobileMarketListOpen(false);
      setIsMobileTradeSheetOpen(false);
      setIsMobileChartFullscreen(false);
    },
  });

  // Sync UI state with tutorial steps (switch tabs)
  useEffect(() => {
    if (!tutorial.isActive) return;
    const step = tutorial.steps[tutorial.currentStep];
    if (!step) return;

    // Auto-switch bottom tab based on step title
    if (step.title === "Social Feed") {
      setBottomTab("social");
    } else if (step.title === "AI Agents") {
      setBottomTab("agent");
    }
  }, [tutorial.isActive, tutorial.currentStep, tutorial.steps]);

  // Cooldown state to prevent refresh spam (protects backend at scale)
  const [refreshOnCooldown, setRefreshOnCooldown] = useState(false);
  const refreshCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup cooldown timer on unmount
  useEffect(() => {
    return () => {
      if (refreshCooldownRef.current) {
        clearTimeout(refreshCooldownRef.current);
      }
    };
  }, []);

  const openMobilePanel = useCallback((tab?: BottomTab) => {
    if (tab) setBottomTab(tab);
    setIsMobilePanelOpen(true);
    setIsMobileMarketListOpen(false);
    setIsMobileTradeSheetOpen(false);
  }, []);

  const handleMobileTabSelect = useCallback(
    (tab: MobileTab) => {
      setIsMobileChartFullscreen(false);

      if (tab === "chart") {
        // Only remount chart when returning from a non-chart surface
        const wasOnChart =
          !isMobilePanelOpen &&
          !isMobileMarketListOpen &&
          !isMobileTradeSheetOpen;
        if (!wasOnChart) {
          setMobileChartAnimationKey((k) => k + 1);
        }
        setIsMobilePanelOpen(false);
        setIsMobileMarketListOpen(false);
        setIsMobileTradeSheetOpen(false);
        return;
      }

      openMobilePanel(tab);
    },
    [
      openMobilePanel,
      isMobilePanelOpen,
      isMobileMarketListOpen,
      isMobileTradeSheetOpen,
    ],
  );

  // Shared handlers for TerminalPortfolio (used in both desktop and mobile)
  const handlePortfolioRefresh = useCallback(() => {
    // Prevent refresh if on cooldown
    if (refreshOnCooldown) return;

    invalidateUserPositions();
    invalidateWalletBalance();
    void Promise.allSettled([
      refreshPortfolio(),
      refreshPredictionPositions(),
      refreshPerpPositions(),
      refreshWalletBalance(),
    ]);

    // Start cooldown to prevent rapid successive refreshes
    setRefreshOnCooldown(true);
    refreshCooldownRef.current = setTimeout(() => {
      setRefreshOnCooldown(false);
    }, REFRESH_COOLDOWN_MS);
  }, [
    refreshOnCooldown,
    refreshPortfolio,
    refreshPredictionPositions,
    refreshPerpPositions,
    refreshWalletBalance,
  ]);

  // Shared helper to refresh all position-related data after a trade/close action
  const refreshAllPositionData = useCallback(async () => {
    invalidateUserPositions();
    invalidateWalletBalance();
    await Promise.all([
      refreshPerpPositions(),
      refreshPredictionPositions(),
      refreshWalletBalance(),
      refreshPortfolio(),
    ]);
  }, [
    refreshPerpPositions,
    refreshPredictionPositions,
    refreshWalletBalance,
    refreshPortfolio,
  ]);

  const handlePerpPositionClosed = useCallback(async () => {
    await refreshAllPositionData();
  }, [refreshAllPositionData]);

  const handlePredictionPositionSold = useCallback(async () => {
    await refreshAllPositionData();
  }, [refreshAllPositionData]);

  const mobileBottomDockOffset = useMemo(() => {
    // Position the dock above the fixed BottomNav. Use the measured nav height
    // so it accounts for safe-area insets on devices like Pixel 10 Pro.
    return mobileBottomNavHeight;
  }, [mobileBottomNavHeight]);

  // Track the height of the app's fixed BottomNav to properly position the mobile dock.
  // We use DOM query because BottomNav is rendered in the app layout outside this component's
  // React tree, so we can't use props/context. The 'app-bottom-nav' ID is set in BottomNav.tsx.
  useEffect(() => {
    // SSR safety: ensure we're in browser environment
    if (typeof window === "undefined") {
      return () => {};
    }

    const bottomNav = document.getElementById("app-bottom-nav");

    // Define update function outside conditional for consistent cleanup
    const updateHeight = () => {
      if (bottomNav) {
        setMobileBottomNavHeight(bottomNav.getBoundingClientRect().height);
      } else {
        setMobileBottomNavHeight(0);
      }
    };

    // Initial measurement
    updateHeight();

    // If no bottomNav found, still return cleanup (currently no-op but consistent pattern)
    if (!bottomNav) {
      return () => {};
    }

    // ResizeObserver may not exist in older browsers
    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => updateHeight())
        : null;

    resizeObserver?.observe(bottomNav);
    window.addEventListener("resize", updateHeight, { passive: true });

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, []);

  useEffect(() => {
    if (!isFullscreen) return undefined;

    previousOverflowRef.current = {
      body: document.body.style.overflow,
      html: document.documentElement.style.overflow,
    };
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflowRef.current?.body ?? "";
      document.documentElement.style.overflow =
        previousOverflowRef.current?.html ?? "";
      previousOverflowRef.current = null;
    };
  }, [isFullscreen]);

  useEffect(() => {
    if (!isFullscreen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isFullscreen]);

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev);
  }, []);

  useEffect(() => {
    if (!showMarketsMenu) return undefined;

    const onMouseDown = (event: MouseEvent) => {
      if (
        marketsMenuRef.current &&
        !marketsMenuRef.current.contains(event.target as Node)
      ) {
        setShowMarketsMenu(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowMarketsMenu(false);
    };

    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [showMarketsMenu]);

  // One-way sync from URL → local UI state
  useEffect(() => {
    const nextFilter = parseFilter(searchParams);
    setFilter(nextFilter);
    setSelected(parseSelected(searchParams));
    setSortBy(parseSort(searchParams));
    setSortDesc(parseSortDesc(searchParams));

    const nextPerpSide = parsePerpSide(searchParams);
    const nextPredSide = parsePredictionSide(searchParams);
    setPerpSideFromUrl(nextPerpSide);
    if (nextPerpSide) {
      // Perps order entry manages its own side; we only use this to open the trade sheet.
      setIsMobileTradeSheetOpen(true);
    }
    if (nextPredSide) setPredictionSide(nextPredSide);
  }, [searchParams]);

  const isFavorite = useMarketWatchlistStore((s) => s.isFavorite);

  const rows: UnifiedRow[] = useMemo(() => {
    const q = query.trim().toLowerCase();

    const perps: UnifiedRow[] = perpMarkets.map((m) => ({
      key: { kind: "perp", id: m.ticker },
      kind: "perp",
      title: m.ticker,
      subtitle: perpCompanyLabel(m.name),
      valuePrimary: `${FEED_POINTS_SYMBOL}${m.currentPrice.toFixed(2)}`,
      valueSecondary: `Vol ${formatCompactNumber(m.volume24h)}`,
      change24hPct: m.changePercent24h,
      sortVolume: m.volume24h ?? 0,
      sortOpenInterest: m.openInterest ?? 0,
      sortName: m.ticker.toLowerCase(),
      perpImageUrl: m.imageUrl ?? null,
      perpMarket: m,
    }));

    const preds: UnifiedRow[] = predictionMarkets.map((m) => {
      const yesPct = computeYesPctFromShares(
        m as PredictionMarketTerminalState,
      );
      const vol = Number(m.yesShares ?? 0) + Number(m.noShares ?? 0);
      return {
        key: { kind: "prediction", id: m.id.toString() },
        kind: "prediction",
        title: m.text,
        subtitle: `Scenario ${m.scenario}`,
        valuePrimary: `YES ${formatYesPct(yesPct)}`,
        valueSecondary:
          m.status !== "active"
            ? m.status.toUpperCase()
            : vol > 0
              ? `Vol ${formatCompactNumber(vol)}`
              : undefined,
        change24hPct: null,
        sortVolume: vol,
        sortOpenInterest: 0,
        sortName: m.text.toLowerCase(),
        predictionMarket: m,
      };
    });

    const combined = [...perps, ...preds];

    const filtered = combined.filter((row) => {
      if (filter === "favorites") {
        if (!isFavorite(row.key)) return false;
      } else if (filter !== "all" && row.kind !== filter) {
        return false;
      }
      if (q.length === 0) return true;
      return (
        row.title.toLowerCase().includes(q) ||
        row.subtitle.toLowerCase().includes(q) ||
        (row.kind === "perp" && row.perpMarket?.name.toLowerCase().includes(q))
      );
    });

    return filtered.sort((a, b) => {
      const compareNumbers = (valA: number, valB: number) =>
        sortDesc ? valB - valA : valA - valB;

      if (sortBy === "name") {
        const byName = a.sortName.localeCompare(b.sortName);
        return sortDesc ? -byName : byName;
      }

      if (sortBy === "change") {
        // Use direction-aware sentinel so nulls always sort last
        const sentinel = sortDesc
          ? Number.NEGATIVE_INFINITY
          : Number.POSITIVE_INFINITY;
        const valA = a.change24hPct ?? sentinel;
        const valB = b.change24hPct ?? sentinel;
        const byChange = compareNumbers(valA, valB);
        if (byChange !== 0) return byChange;
      } else if (sortBy === "openInterest") {
        const byOI = compareNumbers(a.sortOpenInterest, b.sortOpenInterest);
        if (byOI !== 0) return byOI;
      } else {
        const byVol = compareNumbers(a.sortVolume, b.sortVolume);
        if (byVol !== 0) return byVol;
      }

      const byVolFallback = compareNumbers(a.sortVolume, b.sortVolume);
      if (byVolFallback !== 0) return byVolFallback;
      return a.sortName.localeCompare(b.sortName);
    });
  }, [
    perpMarkets,
    predictionMarkets,
    query,
    filter,
    sortBy,
    sortDesc,
    isFavorite,
  ]);

  // When a market is selected but no longer exists in data, deselect back to dashboard
  useEffect(() => {
    if (!selected || rows.length === 0) return;
    const stillExists = rows.some(
      (row) =>
        row.key.kind === selected.kind &&
        row.key.id.toString() === selected.id.toString(),
    );
    if (!stillExists) {
      setSelected(null);
      const next = new URLSearchParams(searchParams.toString());
      next.delete("marketKind");
      next.delete("marketId");
      router.replace(`/markets?${next.toString()}`, { scroll: false });
    }
  }, [selected, rows, router, searchParams]);

  // Removed: auto-open dropdown — keep it closed by default

  const selectedPerp = useMemo(() => {
    if (!selected || selected.kind !== "perp") return null;
    return (
      perpMarkets.find(
        (m) => m.ticker.toUpperCase() === selected.id.toUpperCase(),
      ) ?? null
    );
  }, [selected, perpMarkets]);

  const selectedPredictionId =
    selected?.kind === "prediction" ? selected.id : null;
  const selectedPredictionMarket = useMemo(() => {
    if (!selectedPredictionId) return null;
    return (
      predictionMarkets.find((m) => m.id.toString() === selectedPredictionId) ??
      null
    );
  }, [predictionMarkets, selectedPredictionId]);
  const [predictionLiveState, setPredictionLiveState] =
    useState<PredictionMarketLiveState | null>(null);

  useEffect(() => {
    setPredictionLiveState((prev) =>
      prev?.marketId === selectedPredictionId ? prev : null,
    );
  }, [selectedPredictionId]);

  const predictionState = useMemo(
    () =>
      buildPredictionTerminalState(
        selectedPredictionMarket,
        predictionLiveState,
      ),
    [selectedPredictionMarket, predictionLiveState],
  );

  const handlePredictionTradeEvent = useCallback(
    (event: PredictionTradeSSE) => {
      setPredictionLiveState((prev) => {
        const next = buildPredictionLiveStateFromTrade(event, prev);
        return isSamePredictionLiveState(prev, next) ? prev : next;
      });
    },
    [],
  );

  const handlePredictionResolutionEvent = useCallback(
    (event: PredictionResolutionSSE) => {
      setPredictionLiveState((prev) => {
        const next = buildPredictionLiveStateFromResolution(event, prev);
        return isSamePredictionLiveState(prev, next) ? prev : next;
      });
    },
    [],
  );

  usePredictionMarketStream(selectedPredictionId, {
    onTrade: handlePredictionTradeEvent,
    onResolution: handlePredictionResolutionEvent,
  });

  const predictionEffectiveShares = useMemo(() => {
    if (!predictionState) return null;

    const yes = Number(predictionState.yesShares ?? 0);
    const no = Number(predictionState.noShares ?? 0);

    if (yes > 0 && no > 0) {
      return {
        yesShares: yes,
        noShares: no,
        liquidity: Number(predictionState.liquidity ?? yes + no),
      };
    }

    const seeded = PredictionPricing.initializeMarket();
    return {
      yesShares: seeded.yesShares,
      noShares: seeded.noShares,
      liquidity: seeded.yesShares + seeded.noShares,
    };
  }, [predictionState]);

  const predictionHistorySeed = useMemo(
    () =>
      predictionEffectiveShares
        ? {
            yesShares: predictionEffectiveShares.yesShares,
            noShares: predictionEffectiveShares.noShares,
            liquidity: predictionEffectiveShares.liquidity,
          }
        : undefined,
    [predictionEffectiveShares],
  );

  const { history: predictionHistory, refresh: refreshPredictionHistory } =
    usePredictionHistory(selected?.kind === "prediction" ? selected.id : null, {
      limit: 1000,
      seed: predictionHistorySeed,
      range: predictionTimeRange,
    });

  const { history: perpHistory } = usePerpHistory(
    selectedPerp?.ticker ?? null,
    { range: perpTimeRange },
  );

  const handleSelect = useCallback(
    (key: MarketKey) => {
      setSelected(key);
      setContentTab("chart");
      const next = new URLSearchParams(searchParams.toString());
      next.set("marketKind", key.kind);
      next.set("marketId", key.id);
      next.set("filter", filter);
      next.delete("tab");
      next.delete("tabs");
      next.delete("side");
      router.replace(`/markets?${next.toString()}`, { scroll: false });
      setIsMobileMarketListOpen(false);
    },
    [router, searchParams, filter],
  );

  const handleBackToDashboard = useCallback(() => {
    setSelected(null);
    setContentTab("chart");
    const next = new URLSearchParams(searchParams.toString());
    next.delete("marketKind");
    next.delete("marketId");
    next.delete("side");
    router.replace(`/markets?${next.toString()}`, { scroll: false });
  }, [router, searchParams]);

  const handleFilterChange = useCallback(
    (nextFilter: MarketsFilter) => {
      setFilter(nextFilter);
      const next = new URLSearchParams(searchParams.toString());
      next.set("filter", nextFilter);
      next.delete("tab");
      next.delete("tabs");
      next.delete("side");
      router.replace(`/markets?${next.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const handleSortChange = useCallback(
    (nextSort: MarketsSort) => {
      const next = new URLSearchParams(searchParams.toString());
      if (sortBy === nextSort) {
        const nextDesc = !sortDesc;
        setSortDesc(nextDesc);
        next.set("sort", nextSort);
        next.set("sortDir", nextDesc ? "desc" : "asc");
      } else {
        setSortBy(nextSort);
        setSortDesc(true);
        next.set("sort", nextSort);
        next.set("sortDir", "desc");
      }
      router.replace(`/markets?${next.toString()}`, { scroll: false });
    },
    [router, searchParams, sortBy, sortDesc],
  );

  const selectedPredictionPositions = useMemo(() => {
    if (!selectedPredictionId) return [];
    return predictionPositions.filter(
      (p) => p.marketId.toString() === selectedPredictionId,
    );
  }, [predictionPositions, selectedPredictionId]);

  // Compute sellable positions per side - only positions with shares >= MIN_SELLABLE_SHARES
  // are actually sellable. We check individual positions, not aggregated totals, because
  // a user might have multiple small positions that sum above threshold but none are sellable.
  const sellablePositions = useMemo(() => {
    const sellableYes = selectedPredictionPositions.filter(
      (p) => p.side === "YES" && p.shares >= MIN_SELLABLE_SHARES,
    );
    const sellableNo = selectedPredictionPositions.filter(
      (p) => p.side === "NO" && p.shares >= MIN_SELLABLE_SHARES,
    );
    return {
      hasSellableYes: sellableYes.length > 0,
      hasSellableNo: sellableNo.length > 0,
      sellableYesCount: sellableYes.length,
      sellableNoCount: sellableNo.length,
    };
  }, [selectedPredictionPositions]);

  const canSellPrediction =
    authenticated &&
    (sellablePositions.hasSellableYes || sellablePositions.hasSellableNo);

  // Consolidated sell mode effect - handles both mode switching and side switching
  // to prevent cascading state updates from separate effects
  useEffect(() => {
    if (predictionTradeMode !== "sell") return;

    // If can't sell at all, switch to buy mode
    if (!canSellPrediction) {
      setPredictionTradeMode("buy");
      setPredictionSellShares("");
      return;
    }

    // If can sell but not on current side, switch to the other side
    const canSellThisSide =
      predictionSide === "yes"
        ? sellablePositions.hasSellableYes
        : sellablePositions.hasSellableNo;

    if (!canSellThisSide) {
      const canSellOtherSide =
        predictionSide === "yes"
          ? sellablePositions.hasSellableNo
          : sellablePositions.hasSellableYes;
      if (canSellOtherSide) {
        setPredictionSide((prev) => (prev === "yes" ? "no" : "yes"));
        setPredictionSellShares("");
      }
    }
  }, [
    canSellPrediction,
    predictionSide,
    predictionTradeMode,
    sellablePositions.hasSellableNo,
    sellablePositions.hasSellableYes,
  ]);

  const selectedPerpTickerUpper = selectedPerp?.ticker.toUpperCase() ?? null;
  const selectedPerpPositions = useMemo(() => {
    if (!selectedPerpTickerUpper) return [];
    return perpPositions.filter(
      (p) => p.ticker.toUpperCase() === selectedPerpTickerUpper && !p.closedAt,
    );
  }, [perpPositions, selectedPerpTickerUpper]);

  const otherPerpPositions = useMemo(() => {
    if (perpPositions.length === 0) return [];
    if (selected?.kind !== "perp" || !selectedPerpTickerUpper) {
      return perpPositions;
    }
    return perpPositions.filter(
      (p) => p.ticker.toUpperCase() !== selectedPerpTickerUpper || p.closedAt,
    );
  }, [perpPositions, selected?.kind, selectedPerpTickerUpper]);

  const otherPredictionPositions = useMemo(() => {
    if (predictionPositions.length === 0) return [];
    if (selected?.kind !== "prediction" || !selectedPredictionId) {
      return predictionPositions;
    }
    return predictionPositions.filter(
      (p) => p.marketId.toString() !== selectedPredictionId,
    );
  }, [predictionPositions, selected?.kind, selectedPredictionId]);

  const predictionAmountNum = Number.parseFloat(predictionAmount) || 0;
  const predictionSellSharesNum = Number.parseFloat(predictionSellShares) || 0;

  const predictionBuyCalculation = useMemo(() => {
    if (!predictionEffectiveShares) return null;
    if (predictionAmountNum <= 0) return null;
    try {
      return PredictionPricing.calculateBuyWithFees(
        predictionEffectiveShares.yesShares,
        predictionEffectiveShares.noShares,
        predictionSide,
        predictionAmountNum,
        FEE_CONFIG.TRADING_FEE_RATE,
      );
    } catch {
      return null;
    }
  }, [predictionEffectiveShares, predictionSide, predictionAmountNum]);

  const sellPosition = useMemo(() => {
    const wantedSide = predictionSide.toUpperCase() as "YES" | "NO";
    const candidates = selectedPredictionPositions.filter(
      (p) => p.side === wantedSide && p.shares >= MIN_SELLABLE_SHARES,
    );
    if (candidates.length === 0) return null;
    const first = candidates[0];
    if (!first) return null;
    return candidates
      .slice(1)
      .reduce((best, pos) => (pos.shares > best.shares ? pos : best), first);
  }, [predictionSide, selectedPredictionPositions]);

  const maxSellShares = sellPosition?.shares ?? 0;
  const clampedSellShares =
    predictionSellSharesNum > 0
      ? Math.min(predictionSellSharesNum, maxSellShares)
      : 0;

  const predictionSellCalculation = useMemo(() => {
    if (!predictionEffectiveShares) return null;
    if (!sellPosition) return null;
    if (clampedSellShares <= 0) return null;
    try {
      return PredictionPricing.calculateSellWithFees(
        predictionEffectiveShares.yesShares,
        predictionEffectiveShares.noShares,
        predictionSide,
        clampedSellShares,
        FEE_CONFIG.TRADING_FEE_RATE,
      );
    } catch {
      return null;
    }
  }, [
    predictionEffectiveShares,
    predictionSide,
    sellPosition,
    clampedSellShares,
  ]);

  const expectedPayout = useMemo(() => {
    if (!predictionBuyCalculation) return 0;
    return calculateExpectedPayout(
      predictionBuyCalculation.sharesBought,
      predictionBuyCalculation.avgPrice,
    );
  }, [predictionBuyCalculation]);
  const expectedProfit = expectedPayout - predictionAmountNum;

  const handlePredictionSubmit = () => {
    if (!authenticated) {
      login();
      return;
    }
    if (!predictionState) return;
    if (predictionState.status !== "active" || predictionState.resolved) {
      toast.error("This market is not active.");
      return;
    }
    if (predictionTradeMode === "buy") {
      if (predictionAmountNum < 1) {
        toast.error(`Minimum bet is ${FEED_POINTS_SYMBOL}1`);
        return;
      }
      if (!predictionBuyCalculation) {
        toast.error("Unable to calculate buy quote.");
        return;
      }
    } else {
      if (!sellPosition) {
        toast.error("No sellable position for this side.");
        return;
      }
      if (clampedSellShares < MIN_SELLABLE_SHARES) {
        toast.error(`Minimum sell is ${MIN_SELLABLE_SHARES} shares`);
        return;
      }
      if (!predictionSellCalculation) {
        toast.error("Unable to calculate sell quote.");
        return;
      }
    }
    setConfirmDialogOpen(true);
  };

  const handleConfirmPredictionTrade = async () => {
    if (!predictionState) return;
    if (predictionTradeMode === "buy" && !predictionBuyCalculation) {
      toast.error("Invalid buy amount.");
      return;
    }
    if (predictionTradeMode === "sell") {
      if (!sellPosition) {
        toast.error("No sellable position for this side.");
        return;
      }
      if (clampedSellShares < MIN_SELLABLE_SHARES) {
        toast.error(`Minimum sell is ${MIN_SELLABLE_SHARES} shares`);
        return;
      }
      if (!predictionSellCalculation) {
        toast.error("Unable to calculate sell quote.");
        return;
      }
    }

    setPredictionSubmitting(true);
    setConfirmDialogOpen(false);

    try {
      const token = await getAccessToken();
      if (!token) {
        toast.error("Authentication required. Please log in.");
        return;
      }

      const url =
        predictionTradeMode === "buy"
          ? `/api/markets/predictions/${encodeURIComponent(
              predictionState.id.toString(),
            )}/buy`
          : `/api/markets/predictions/${encodeURIComponent(
              predictionState.id.toString(),
            )}/sell`;

      // Note: sellPosition is validated earlier in this function for sell mode
      const body =
        predictionTradeMode === "buy"
          ? { side: predictionSide, amount: predictionAmountNum }
          : { shares: clampedSellShares, positionId: sellPosition?.id };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (!response.ok) {
        const maybeError = data as {
          error?: unknown;
          message?: unknown;
        } | null;
        const errorMessage =
          typeof maybeError?.error === "object"
            ? ((maybeError.error as { message?: unknown })
                ?.message as string) ||
              (predictionTradeMode === "sell"
                ? "Failed to sell shares"
                : "Failed to buy shares")
            : (maybeError?.error as string) ||
              (maybeError?.message as string) ||
              (predictionTradeMode === "sell"
                ? "Failed to sell shares"
                : "Failed to buy shares");
        toast.error(errorMessage);
        return;
      }

      if (predictionTradeMode === "buy") {
        toast.success(`Bought ${predictionSide.toUpperCase()} shares!`, {
          description: predictionBuyCalculation
            ? `${predictionBuyCalculation.sharesBought.toFixed(
                2,
              )} shares at ${predictionBuyCalculation.avgPrice.toFixed(3)} each`
            : undefined,
        });
      } else {
        toast.success(`Sold ${predictionSide.toUpperCase()} shares!`, {
          description: `${clampedSellShares.toFixed(2)} shares sold`,
        });
      }

      invalidateUserPositions();
      invalidateWalletBalance();
      await Promise.all([
        refreshPredictionPositions(),
        refreshPerpPositions(),
        refreshWalletBalance(),
        refreshPredictionHistory(),
        refreshPortfolio(),
      ]);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to trade";
      toast.error(message);
    } finally {
      setPredictionSubmitting(false);
    }
  };

  const desktopTradesContainerRef = useRef<HTMLDivElement | null>(null);
  const mobileTradesContainerRef = useRef<HTMLDivElement | null>(null);

  const listPanel = (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={marketsMenuRef}
        className="shrink-0 space-y-2 border-white/5 border-b p-3"
      >
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              className="absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
              size={14}
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="w-full rounded border border-border bg-background/40 py-2 pr-3 pl-8 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowMarketsMenu((v) => !v)}
            aria-expanded={showMarketsMenu}
            aria-controls="markets-filter-sort"
            className={cn(
              "shrink-0 rounded p-2 transition-colors hover:bg-muted/20",
              showMarketsMenu || sortBy !== "volume" || sortDesc !== true
                ? "bg-muted/20 text-primary"
                : "text-muted-foreground",
            )}
            aria-label="Sort markets"
            title="Sort"
          >
            <ArrowUpDown size={14} />
          </button>
        </div>

        {showMarketsMenu && (
          <div
            id="markets-filter-sort"
            className="fade-in-0 animate-in rounded-md border border-white/10 bg-background/40 py-1 shadow-sm duration-150"
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/20"
              onClick={() => {
                handleFilterChange(
                  filter === "favorites" ? "all" : "favorites",
                );
              }}
            >
              <div
                className={cn(
                  "flex h-3.5 w-3.5 items-center justify-center rounded-sm border transition-colors",
                  filter === "favorites"
                    ? "border-primary bg-primary"
                    : "border-muted-foreground/40",
                )}
              >
                {filter === "favorites" && (
                  <Check size={10} className="text-primary-foreground" />
                )}
              </div>
              <span
                className={cn(
                  filter === "favorites"
                    ? "font-medium text-primary"
                    : "text-foreground",
                )}
              >
                Favorites only
              </span>
            </button>

            <div className="my-1 border-white/10 border-t" />

            <div className="px-3 py-2 font-bold text-[10px] text-muted-foreground uppercase tracking-wider">
              Sort By
            </div>
            {(
              [
                { id: "volume", label: "Volume" },
                { id: "change", label: "24h Change" },
                { id: "openInterest", label: "Open Interest" },
                { id: "name", label: "Name" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-muted/20"
                onClick={() => handleSortChange(opt.id)}
              >
                <span
                  className={cn(
                    opt.id === sortBy
                      ? "font-medium text-primary"
                      : "text-foreground",
                  )}
                >
                  {opt.label}
                </span>
                {opt.id === sortBy && (
                  <ArrowUpDown
                    size={12}
                    className={cn(
                      "text-primary transition-transform",
                      sortDesc ? "rotate-0" : "rotate-180",
                    )}
                  />
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="relative flex shrink-0">
        {(
          [
            { id: "all", label: "All" },
            { id: "perp", label: "Perps" },
            { id: "prediction", label: "Prediction" },
          ] as const
        ).map((tab) => {
          const isActive =
            filter === tab.id || (tab.id === "all" && filter === "favorites");
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleFilterChange(tab.id)}
              className={cn(
                "relative flex-1 py-2.5 font-semibold text-xs transition-colors hover:bg-muted/20",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground",
              )}
            >
              {tab.label}
              {isActive && (
                <div className="absolute right-0 bottom-0 left-0 h-[2px] bg-primary" />
              )}
            </button>
          );
        })}
        <div className="absolute right-0 bottom-0 left-0 h-px bg-white/5" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {(perpLoading || predictionLoading) && rows.length === 0 ? (
          <div className="divide-y divide-white/5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-2">
                <Skeleton className="h-12 w-12 shrink-0 rounded-xl" />
                <div className="min-w-0 flex-1 space-y-1">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-2.5 w-1/2" />
                </div>
                <div className="space-y-1 text-right">
                  <Skeleton className="ml-auto h-3.5 w-12" />
                </div>
                <Skeleton className="h-5 w-14 rounded-full" />
              </div>
            ))}
          </div>
        ) : perpError || predictionError ? (
          <div className="p-4 text-muted-foreground text-sm">
            Failed to load markets.
          </div>
        ) : (
          <table className="w-full table-fixed text-left text-xs">
            <colgroup>
              <col />
              <col className="w-24" />
              <col className="w-16" />
            </colgroup>
            <thead className="sr-only">
              <tr className="border-white/5 border-b">
                <th className="px-2 py-2">Market</th>
                <th className="px-2 py-2 text-right">Value</th>
                <th className="px-3 py-2 text-right">24h</th>
              </tr>
            </thead>
            <tbody className="border-white/5 border-t">
              {rows.map((row) => {
                const active =
                  selected?.kind === row.key.kind &&
                  selected.id.toString() === row.key.id.toString();
                const change = row.change24hPct;
                return (
                  <tr
                    key={`${row.key.kind}:${row.key.id}`}
                    className={cn(
                      "cursor-pointer border-white/5 border-b transition-colors hover:bg-muted/20",
                      active && "bg-muted/30",
                    )}
                    onClick={() => handleSelect(row.key)}
                  >
                    <td className="px-2 py-2">
                      <div className="flex min-w-0 items-center gap-2.5">
                        {row.kind === "perp" && row.perpMarket ? (
                          <PerpOrgAvatar
                            imageUrl={
                              row.perpImageUrl ?? row.perpMarket.imageUrl
                            }
                            label={row.perpMarket.name || row.title}
                            size="md"
                          />
                        ) : null}
                        <div className="flex min-w-0 flex-col">
                          <div className="line-clamp-2 font-bold text-foreground">
                            {row.title}
                          </div>
                          <div className="truncate text-[10px] text-foreground/50">
                            {row.subtitle}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="overflow-hidden px-2 py-2 text-right">
                      <div className="truncate text-right font-mono font-semibold text-foreground text-xs tabular-nums">
                        {row.valuePrimary}
                      </div>
                      {row.valueSecondary && (
                        <div className="truncate text-right font-mono font-semibold text-[11px] text-foreground/80 tabular-nums">
                          {row.valueSecondary}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4 pl-2 text-right">
                      {row.kind === "perp" && change != null ? (
                        <div
                          className={cn(
                            "inline-flex items-center justify-end rounded-full px-2 py-0.5 font-bold text-[10px] tabular-nums",
                            change >= 0
                              ? "bg-green-500/10 text-green-500"
                              : "bg-red-500/10 text-red-500",
                          )}
                        >
                          {change >= 0 ? "+" : ""}
                          {change.toFixed(2)}%
                        </div>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={3}
                    className="p-6 text-center text-muted-foreground"
                  >
                    No markets found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );

  const predictionYesPct = useMemo(() => {
    if (!predictionState) return 50;
    return computeYesPctFromShares(predictionState);
  }, [predictionState]);

  const centerPanel = (
    <div
      data-tour="chart-area"
      className="flex h-full min-h-0 flex-col bg-background/10"
    >
      {selected?.kind === "prediction" ? (
        <>
          <div className="relative shrink-0 border-white/5 border-b px-4 py-2.5">
            {/* Row 1: Title + action buttons */}
            <div className="flex items-start gap-3">
              <Link
                href="/markets"
                className="mt-[3px] inline-flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
                aria-label="Back to markets"
                title="Back to markets"
              >
                <ArrowLeft size={14} />
              </Link>
              <div data-tour="market-dropdown" className="min-w-0">
                <div className="line-clamp-2 text-balance font-semibold text-foreground text-sm leading-snug">
                  {predictionState?.text ?? "Prediction market"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setPredictionDetailsOpen(true)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
                  aria-label="View market details"
                  title="Details"
                >
                  <Info size={14} />
                </button>
                <button
                  type="button"
                  onClick={toggleFullscreen}
                  aria-pressed={isFullscreen}
                  aria-label={
                    isFullscreen
                      ? "Exit fullscreen terminal view"
                      : "Enter fullscreen terminal view"
                  }
                  title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                  className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
                >
                  {isFullscreen ? (
                    <Minimize2 size={14} />
                  ) : (
                    <Maximize2 size={14} />
                  )}
                </button>
                <TutorialHelpButton onClick={tutorial.restart} />
              </div>
            </div>

            {/* Row 2: Metadata + YES/NO + time range */}
            <div className="mt-1.5 flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <div className="truncate text-muted-foreground text-xs">
                  {predictionState?.resolutionDescription?.trim()
                    ? predictionState.resolutionDescription
                    : `Scenario ${predictionState?.scenario ?? ""}${
                        formatDate(
                          predictionState?.endDate ??
                            predictionState?.resolutionDate,
                        )
                          ? ` • Ends ${formatDate(
                              predictionState?.endDate ??
                                predictionState?.resolutionDate,
                            )}`
                          : ""
                      }`}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <div className="rounded-full bg-blue-500/10 px-2 py-0.5 font-bold text-[10px] text-blue-400 tabular-nums">
                    YES {formatYesPct(predictionYesPct)}
                  </div>
                  <div className="rounded-full bg-violet-500/10 px-2 py-0.5 font-bold text-[10px] text-violet-400 tabular-nums">
                    NO {formatYesPct(100 - predictionYesPct)}
                  </div>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1 rounded-md bg-muted/20 p-0.5 font-semibold text-[11px]">
                {MARKET_TIME_RANGES.map((range) => (
                  <button
                    key={range}
                    type="button"
                    onClick={() => setPredictionTimeRange(range)}
                    className={cn(
                      "rounded px-1.5 py-0.5 transition-colors",
                      predictionTimeRange === range
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {range}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 p-4">
            <PredictionProbabilityChart
              data={predictionHistory}
              marketId={selectedPredictionId ?? "unknown"}
              timeRange={predictionTimeRange}
              onTimeRangeChange={setPredictionTimeRange}
              showHeader={false}
              height="fill"
            />
          </div>
        </>
      ) : selectedPerp ? (
        <>
          <div className="relative flex shrink-0 items-center justify-between gap-3 border-white/5 border-b px-4 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <Link
                href="/markets"
                className="inline-flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
                aria-label="Back to markets"
                title="Back to markets"
              >
                <ArrowLeft size={14} />
              </Link>
              <div
                data-tour="market-dropdown"
                className="flex min-w-0 items-center gap-2"
              >
                <PerpOrgAvatar
                  imageUrl={selectedPerp.imageUrl}
                  label={selectedPerp.name || selectedPerp.ticker}
                  size="md"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-semibold text-foreground text-sm">
                    ${selectedPerp.ticker}
                  </span>
                  <span className="truncate text-muted-foreground text-xs">
                    {perpCompanyLabel(selectedPerp.name)}
                  </span>
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <div className="flex items-center gap-1 rounded-md bg-muted/20 p-0.5 font-semibold text-[11px]">
                {MARKET_TIME_RANGES.map((range) => (
                  <button
                    key={range}
                    type="button"
                    onClick={() => setPerpTimeRange(range)}
                    className={cn(
                      "rounded px-1.5 py-0.5 transition-colors",
                      perpTimeRange === range
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {range}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={toggleFullscreen}
                aria-pressed={isFullscreen}
                aria-label={
                  isFullscreen
                    ? "Exit fullscreen terminal view"
                    : "Enter fullscreen terminal view"
                }
                title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
              >
                {isFullscreen ? (
                  <Minimize2 size={14} />
                ) : (
                  <Maximize2 size={14} />
                )}
              </button>
              <TutorialHelpButton onClick={tutorial.restart} />
            </div>
          </div>
          <div className="min-h-0 flex-1 p-4">
            <PerpPriceChart
              data={perpHistory.map((p) => ({ time: p.time, price: p.price }))}
              currentPrice={selectedPerp.currentPrice}
              ticker={selectedPerp.ticker}
              timeRange={perpTimeRange}
              onTimeRangeChange={setPerpTimeRange}
              showHeader={false}
              height="fill"
              className="h-full"
            />
          </div>
        </>
      ) : (
        <div data-tour="market-dropdown" className="flex h-full flex-col">
          <div className="shrink-0 border-white/5 border-b px-4 py-2.5">
            <Link
              href="/markets"
              className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-muted-foreground text-sm transition-colors hover:text-foreground"
            >
              <ArrowLeft size={14} />
              Markets
            </Link>
          </div>
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            Select a market
          </div>
        </div>
      )}
    </div>
  );

  const rightPanel = (
    <div
      data-tour="order-entry"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      {selected?.kind === "prediction" ? (
        <div className="flex h-full min-h-0 flex-col">
          <div className="border-border border-b px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="text-muted-foreground text-xs">
                  Available Balance
                </div>
                <div className="flex items-center gap-2 font-mono text-base text-foreground tabular-nums">
                  <Wallet size={14} className="text-muted-foreground" />
                  {balanceLoading ? (
                    <Skeleton className="h-5 w-20" />
                  ) : (
                    formatBalance(balance)
                  )}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                {onRequestBuyPoints && (
                  <button
                    type="button"
                    onClick={onRequestBuyPoints}
                    className="rounded bg-primary px-3 py-1 font-sans font-semibold text-primary-foreground text-xs transition-colors hover:bg-primary/90"
                  >
                    Buy
                  </button>
                )}
                {selectedPredictionPositions.length > 0 && (
                  <div className="text-right">
                    <div className="text-muted-foreground text-xs">
                      Open Position
                    </div>
                    <div className="text-xs">
                      {(["YES", "NO"] as const)
                        .map((side) => {
                          const total = selectedPredictionPositions
                            .filter((p) => p.side === side)
                            .reduce((sum, p) => sum + p.shares, 0);
                          return total > 0
                            ? `${side} ${total.toFixed(2)}`
                            : null;
                        })
                        .filter(Boolean)
                        .join(" • ")}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-4 pt-4">
            <div className="flex items-center justify-between">
              <div className="font-medium text-sm">Place Order</div>
              <div className="rounded bg-muted px-2 py-0.5 text-muted-foreground text-xs">
                Standard
              </div>
            </div>

            <div className="mt-3 flex gap-1 rounded bg-muted p-1">
              <button
                type="button"
                onClick={() => setPredictionSide("yes")}
                disabled={
                  predictionTradeMode === "sell" &&
                  canSellPrediction &&
                  !sellablePositions.hasSellableYes
                }
                className={cn(
                  "flex-1 rounded py-2 font-semibold text-xs transition-colors",
                  predictionTradeMode === "sell" &&
                    canSellPrediction &&
                    !sellablePositions.hasSellableYes &&
                    "cursor-not-allowed opacity-50 hover:text-muted-foreground",
                  predictionSide === "yes"
                    ? "bg-green-600 text-white shadow-sm"
                    : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                )}
              >
                YES
              </button>
              <button
                type="button"
                onClick={() => setPredictionSide("no")}
                disabled={
                  predictionTradeMode === "sell" &&
                  canSellPrediction &&
                  !sellablePositions.hasSellableNo
                }
                className={cn(
                  "flex-1 rounded py-2 font-semibold text-xs transition-colors",
                  predictionTradeMode === "sell" &&
                    canSellPrediction &&
                    !sellablePositions.hasSellableNo &&
                    "cursor-not-allowed opacity-50 hover:text-muted-foreground",
                  predictionSide === "no"
                    ? "bg-red-600 text-white shadow-sm"
                    : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                )}
              >
                NO
              </button>
            </div>

            {canSellPrediction && (
              <div className="mt-3 flex gap-1 rounded bg-muted p-1">
                <button
                  type="button"
                  onClick={() => setPredictionTradeMode("buy")}
                  className={cn(
                    "flex-1 rounded py-2 font-semibold text-xs transition-colors",
                    predictionTradeMode === "buy"
                      ? "bg-green-600 text-white shadow-sm"
                      : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                  )}
                >
                  BUY
                </button>
                <button
                  type="button"
                  onClick={() => setPredictionTradeMode("sell")}
                  className={cn(
                    "flex-1 rounded py-2 font-semibold text-xs transition-colors",
                    predictionTradeMode === "sell"
                      ? "bg-red-600 text-white shadow-sm"
                      : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                  )}
                >
                  SELL
                </button>
              </div>
            )}

            {predictionTradeMode === "buy" ? (
              <div className={cn("mt-4", !canSellPrediction && "mt-3")}>
                <div className="mb-1 flex items-center justify-between">
                  <label className="font-medium text-muted-foreground text-xs">
                    Amount
                  </label>
                  <span className="text-muted-foreground text-xs">
                    Min {FEED_POINTS_SYMBOL}1
                  </span>
                </div>
                <input
                  type="number"
                  value={predictionAmount}
                  onChange={(e) => setPredictionAmount(e.target.value)}
                  min={1}
                  step="1"
                  className="w-full rounded border border-border bg-input px-3 py-2.5 font-mono text-sm tabular-nums placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  placeholder="10"
                />
              </div>
            ) : (
              <div className={cn("mt-4", !canSellPrediction && "mt-3")}>
                <div className="mb-1 flex items-center justify-between">
                  <label className="font-medium text-muted-foreground text-xs">
                    Shares
                  </label>
                  <div className="flex items-center gap-2 text-muted-foreground text-xs">
                    <span>Min {MIN_SELLABLE_SHARES}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setPredictionSellShares(
                          maxSellShares > 0 ? maxSellShares.toFixed(2) : "",
                        )
                      }
                      className="rounded bg-muted px-2 py-0.5 hover:bg-muted/80"
                      disabled={maxSellShares <= 0}
                    >
                      Max
                    </button>
                  </div>
                </div>
                <input
                  type="number"
                  value={predictionSellShares}
                  onChange={(e) => setPredictionSellShares(e.target.value)}
                  min={MIN_SELLABLE_SHARES}
                  step="0.01"
                  className="w-full rounded border border-border bg-input px-3 py-2.5 font-mono text-sm tabular-nums placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  placeholder={
                    maxSellShares > 0 ? maxSellShares.toFixed(2) : "0.00"
                  }
                  disabled={maxSellShares <= 0}
                />
                {maxSellShares <= 0 && (
                  <div className="mt-2 text-muted-foreground text-xs">
                    No sellable position for this side.
                  </div>
                )}
              </div>
            )}

            {predictionTradeMode === "buy" && predictionBuyCalculation && (
              <div className="mt-4 space-y-2 rounded bg-muted/50 p-3 text-xs">
                <div className="flex items-center justify-between py-0.5">
                  <span className="text-muted-foreground">Shares</span>
                  <span className="font-mono text-foreground tabular-nums">
                    {predictionBuyCalculation.sharesBought.toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center justify-between py-0.5">
                  <span className="text-muted-foreground">Avg price</span>
                  <span className="font-mono text-foreground tabular-nums">
                    ${predictionBuyCalculation.avgPrice.toFixed(3)}
                  </span>
                </div>
                <div className="flex items-center justify-between py-0.5">
                  <span className="text-muted-foreground">Fee</span>
                  <span className="font-mono text-foreground tabular-nums">
                    {FEED_POINTS_SYMBOL}
                    {predictionBuyCalculation.fee?.toFixed(2) ?? "0.00"}
                  </span>
                </div>
                <div className="flex items-center justify-between py-0.5">
                  <span className="text-muted-foreground">Expected payout</span>
                  <span className="font-mono text-foreground tabular-nums">
                    {FEED_POINTS_SYMBOL}
                    {expectedPayout.toFixed(2)}
                  </span>
                </div>
              </div>
            )}

            {predictionTradeMode === "sell" && predictionSellCalculation && (
              <div className="mt-4 space-y-2 rounded bg-muted/50 p-3 text-xs">
                <div className="flex items-center justify-between py-0.5">
                  <span className="text-muted-foreground">Gross proceeds</span>
                  <span className="font-mono text-foreground tabular-nums">
                    {FEED_POINTS_SYMBOL}
                    {predictionSellCalculation.totalCost.toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center justify-between py-0.5">
                  <span className="text-muted-foreground">Fee</span>
                  <span className="font-mono text-foreground tabular-nums">
                    {FEED_POINTS_SYMBOL}
                    {predictionSellCalculation.fee?.toFixed(2) ?? "0.00"}
                  </span>
                </div>
                <div className="flex items-center justify-between py-0.5 font-semibold">
                  <span className="text-muted-foreground">Net proceeds</span>
                  <span className="font-mono text-foreground tabular-nums">
                    {FEED_POINTS_SYMBOL}
                    {(
                      predictionSellCalculation.netProceeds ??
                      predictionSellCalculation.netAmount ??
                      predictionSellCalculation.totalCost
                    ).toFixed(2)}
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="shrink-0 p-4 pt-0">
            <button
              type="button"
              onClick={handlePredictionSubmit}
              disabled={
                predictionSubmitting ||
                (predictionTradeMode === "buy" &&
                  authenticated &&
                  (predictionAmountNum < 1 || !predictionBuyCalculation)) ||
                (predictionTradeMode === "sell" &&
                  authenticated &&
                  (maxSellShares <= 0 ||
                    clampedSellShares < MIN_SELLABLE_SHARES ||
                    !predictionSellCalculation))
              }
              className={cn(
                "w-full rounded py-3 font-semibold text-sm text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                predictionTradeMode === "buy" && predictionSide === "yes"
                  ? "bg-green-600 hover:bg-green-700"
                  : "bg-red-600 hover:bg-red-700",
              )}
            >
              {predictionSubmitting
                ? "Processing…"
                : !authenticated
                  ? "Log In to Trade"
                  : predictionTradeMode === "buy"
                    ? `BUY ${predictionSide.toUpperCase()} · ${FEED_POINTS_SYMBOL}${predictionAmountNum.toFixed(
                        0,
                      )}`
                    : `SELL ${predictionSide.toUpperCase()} · ${clampedSellShares.toFixed(
                        2,
                      )} shares`}
            </button>
          </div>
        </div>
      ) : selectedPerp ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <PerpsOrderEntryPanel
            market={selectedPerp}
            initialSide={perpSideFromUrl ?? undefined}
            onRequestBuyPoints={onRequestBuyPoints}
          />
        </div>
      ) : (
        <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
          Select a market to trade.
        </div>
      )}
    </div>
  );

  return (
    <div
      ref={terminalRootRef}
      className={cn(
        "relative flex h-full w-full flex-col overflow-hidden bg-background text-foreground",
        isFullscreen && "fixed inset-0 z-[45] h-[100dvh] w-[100dvw] pt-safe",
      )}
    >
      {/* Desktop */}
      <div className="hidden min-h-0 flex-1 flex-col md:flex">
        {!selected ? (
          <MarketsDashboard
            perpMarkets={perpMarkets}
            predictionMarkets={predictionMarkets}
            perpLoading={perpLoading}
            predictionLoading={predictionLoading}
            perpError={!!perpError}
            predictionError={!!predictionError}
            onSelectMarket={handleSelect}
          />
        ) : (
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <div className="flex shrink-0 items-center border-border border-b bg-background">
                <button
                  type="button"
                  onClick={handleBackToDashboard}
                  className="flex items-center gap-1.5 px-3 py-2 text-muted-foreground transition-colors hover:text-foreground"
                  aria-label="Back to dashboard"
                >
                  <ArrowLeft size={14} />
                </button>
                <div className="h-5 w-px bg-border" />
                {(
                  [
                    { id: "chart", label: "Chart" },
                    { id: "agents", label: "Agents" },
                    { id: "social", label: "Social" },
                    { id: "trades", label: "Trades" },
                  ] as const
                ).map((tab) => (
                  <TabButton
                    key={tab.id}
                    active={contentTab === tab.id}
                    onClick={() => setContentTab(tab.id)}
                  >
                    {tab.label}
                  </TabButton>
                ))}
              </div>
              <PanelGroup direction="horizontal" className="min-h-0 flex-1">
                <Panel defaultSize={70} minSize={30} className="min-h-0">
                  {contentTab === "chart" ? (
                    centerPanel
                  ) : contentTab === "agents" ? (
                    <TerminalAgentsChat />
                  ) : contentTab === "social" ? (
                    <TerminalSocialFeed
                      perpTicker={
                        selected?.kind === "perp"
                          ? (selectedPerp?.ticker ?? null)
                          : null
                      }
                    />
                  ) : contentTab === "trades" ? (
                    selected?.kind === "prediction" ? (
                      <div
                        ref={desktopTradesContainerRef}
                        className="h-full overflow-auto"
                      >
                        <AssetTradesFeed
                          marketType="prediction"
                          assetId={selected.id}
                          containerRef={desktopTradesContainerRef}
                          density="compact"
                        />
                      </div>
                    ) : selectedPerp ? (
                      <div
                        ref={desktopTradesContainerRef}
                        className="h-full overflow-auto"
                      >
                        <AssetTradesFeed
                          marketType="perp"
                          assetId={selectedPerp.ticker}
                          containerRef={desktopTradesContainerRef}
                          density="compact"
                        />
                      </div>
                    ) : (
                      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
                        Select a market to see trades.
                      </div>
                    )
                  ) : null}
                </Panel>
                <PanelResizeHandle className="w-1 bg-white/5 hover:bg-primary/40" />
                <Panel
                  defaultSize={30}
                  minSize={22}
                  maxSize={40}
                  className="min-h-0 border-border border-l bg-background"
                >
                  {rightPanel}
                </Panel>
              </PanelGroup>
            </div>
          </div>
        )}
      </div>

      {/* Mobile */}
      <div className="relative flex h-full flex-col overflow-hidden overscroll-none md:hidden">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="contents">
              <div className="relative flex min-h-0 w-full flex-1 flex-col border-white/5 border-b">
                <div
                  data-tour="mobile-tab-bar"
                  className="border-white/5 border-b bg-background/60 px-2 py-2 shadow-sm backdrop-blur-md"
                >
                  <MobileTabBar
                    activeTab={
                      isMobilePanelOpen
                        ? (bottomTab as MobileTab)
                        : ("chart" as const)
                    }
                    onSelect={handleMobileTabSelect}
                  />
                </div>

                {selected?.kind === "prediction" ? (
                  <PredictionMarketHeader
                    predictionState={predictionState}
                    yesPct={predictionYesPct}
                    timeRange={predictionTimeRange}
                    onTimeRangeChange={setPredictionTimeRange}
                    onDetailsClick={() => setPredictionDetailsOpen(true)}
                    onFullscreen={() => setIsMobileChartFullscreen(true)}
                    variant="compact"
                  />
                ) : selectedPerp ? (
                  <PerpMarketHeader
                    selectedPerp={selectedPerp}
                    timeRange={perpTimeRange}
                    onTimeRangeChange={setPerpTimeRange}
                    onFullscreen={() => setIsMobileChartFullscreen(true)}
                    variant="compact"
                  />
                ) : null}

                {selected?.kind === "prediction" ? (
                  <div
                    key={mobileChartAnimationKey}
                    className="fade-in min-h-0 flex-1 animate-in p-2 duration-200"
                  >
                    <PredictionProbabilityChart
                      data={predictionHistory}
                      marketId={selectedPredictionId ?? "unknown"}
                      timeRange={predictionTimeRange}
                      onTimeRangeChange={setPredictionTimeRange}
                      showHeader={false}
                      height="fill"
                    />
                  </div>
                ) : selectedPerp ? (
                  <div
                    key={mobileChartAnimationKey}
                    className="fade-in min-h-0 flex-1 animate-in p-2 duration-200"
                  >
                    <PerpPriceChart
                      data={perpHistory.map((p) => ({
                        time: p.time,
                        price: p.price,
                      }))}
                      currentPrice={selectedPerp.currentPrice}
                      ticker={selectedPerp.ticker}
                      timeRange={perpTimeRange}
                      onTimeRangeChange={setPerpTimeRange}
                      showHeader={false}
                      height="fill"
                      className="h-full"
                    />
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
                    Select a market
                  </div>
                )}
              </div>
            </div>
          </div>

          <div
            className="fixed right-0 left-0 z-40 w-full select-none overflow-hidden rounded-t-[20px] border-white/5 border-t bg-background shadow-[0_-5px_15px_rgba(0,0,0,0.12)]"
            style={{ bottom: mobileBottomDockOffset }}
          >
            <div className="flex h-[72px] items-center justify-between px-2 pb-2 font-medium text-[10px] text-muted-foreground">
              {/* Minimal bottom nav */}
              <button
                type="button"
                data-tour="mobile-dock-markets"
                onClick={() => {
                  setIsMobilePanelOpen(false);
                  setIsMobileTradeSheetOpen(false);
                  setIsMobileMarketListOpen(true);
                }}
                className="flex flex-1 flex-col items-center justify-center gap-1 py-1 font-bold text-foreground"
              >
                Markets
              </button>
              <button
                type="button"
                data-tour="mobile-dock-trade"
                onClick={() => {
                  setIsMobilePanelOpen(false);
                  setIsMobileMarketListOpen(false);
                  setIsMobileTradeSheetOpen(true);
                }}
                disabled={!selected}
                className={cn(
                  "mx-2 inline-flex h-10 flex-[1.5] items-center justify-center rounded-full px-4 font-bold text-sm transition-all",
                  selected
                    ? "bg-foreground text-background active:scale-95"
                    : "cursor-not-allowed bg-muted/40 text-muted-foreground",
                )}
              >
                Trade
              </button>
              <button
                type="button"
                onClick={authenticated ? onRequestBuyPoints : login}
                className="flex flex-1 flex-col items-center justify-center gap-1 py-1 transition-colors hover:text-foreground"
              >
                {authenticated ? (
                  <>
                    <span className="font-semibold">Balance</span>
                    <span className="font-mono text-[11px] tabular-nums">
                      {balanceLoading ? "—" : formatBalance(balance)}
                    </span>
                  </>
                ) : (
                  "Log in"
                )}
              </button>
            </div>
          </div>

          {isMobilePanelOpen && (
            <div className="fade-in slide-in-from-bottom-2 absolute inset-0 z-[70] flex animate-in flex-col bg-background pt-safe pb-safe duration-200">
              <div className="flex items-center gap-2 border-white/5 border-b bg-background/70 px-2 py-2 shadow-sm backdrop-blur-md">
                <MobileTabBar
                  activeTab={bottomTab as MobileTab}
                  onSelect={handleMobileTabSelect}
                />
              </div>

              <div
                key={bottomTab}
                className="fade-in min-h-0 flex-1 animate-in overflow-hidden duration-150"
              >
                {bottomTab === "agent" ? (
                  <TerminalAgentsChat />
                ) : bottomTab === "social" ? (
                  <TerminalSocialFeed
                    perpTicker={
                      selected?.kind === "perp"
                        ? (selectedPerp?.ticker ?? null)
                        : null
                    }
                  />
                ) : bottomTab === "portfolio" ? (
                  <TerminalPortfolio
                    authenticated={authenticated}
                    onRequestBuyPoints={onRequestBuyPoints ?? null}
                    balance={balance}
                    balanceLoading={balanceLoading}
                    portfolio={portfolioPnL}
                    portfolioLoading={portfolioLoading}
                    portfolioError={portfolioError}
                    onRefresh={handlePortfolioRefresh}
                    refreshDisabled={refreshOnCooldown}
                  />
                ) : bottomTab === "positions" ? (
                  !authenticated ? (
                    <div className="flex h-full justify-center pt-6 text-muted-foreground text-sm">
                      Log in to view positions.
                    </div>
                  ) : perpPositions.length === 0 &&
                    predictionPositions.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
                      No open positions
                    </div>
                  ) : (
                    <div className="h-full space-y-2 overflow-auto overscroll-contain p-2">
                      {selected?.kind === "prediction" &&
                        selectedPredictionPositions.length > 0 && (
                          <div className="rounded border border-primary/20 bg-primary/5 p-2">
                            <div className="px-1 pb-2 font-semibold text-primary text-xs uppercase tracking-wider">
                              Selected Market
                            </div>
                            <PredictionPositionsList
                              positions={selectedPredictionPositions}
                              density="compact"
                              onPositionSold={handlePredictionPositionSold}
                            />
                          </div>
                        )}
                      {selected?.kind === "perp" &&
                        selectedPerpPositions.length > 0 && (
                          <div className="rounded border border-primary/20 bg-primary/5 p-2">
                            <div className="px-1 pb-2 font-semibold text-primary text-xs uppercase tracking-wider">
                              Selected Market
                            </div>
                            <PerpPositionsList
                              positions={selectedPerpPositions}
                              density="compact"
                              onPositionClosed={handlePerpPositionClosed}
                            />
                          </div>
                        )}
                      {otherPerpPositions.length > 0 && (
                        <div className="rounded border border-white/10 bg-background/10 p-2">
                          <div className="px-1 pb-2 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                            Perps
                          </div>
                          <PerpPositionsList
                            positions={otherPerpPositions}
                            density="compact"
                            onPositionClosed={handlePerpPositionClosed}
                            onPositionClick={(ticker) =>
                              handleSelect({ kind: "perp", id: ticker })
                            }
                          />
                        </div>
                      )}
                      {otherPredictionPositions.length > 0 && (
                        <div className="rounded border border-white/10 bg-background/10 p-2">
                          <div className="px-1 pb-2 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                            Predictions
                          </div>
                          <PredictionPositionsList
                            positions={otherPredictionPositions}
                            density="compact"
                            onPositionSold={handlePredictionPositionSold}
                            onPositionClick={(marketId) =>
                              handleSelect({ kind: "prediction", id: marketId })
                            }
                          />
                        </div>
                      )}
                    </div>
                  )
                ) : bottomTab === "trades" ? (
                  selected?.kind === "prediction" ? (
                    <div
                      ref={mobileTradesContainerRef}
                      className="h-full overflow-auto overscroll-contain"
                    >
                      <AssetTradesFeed
                        marketType="prediction"
                        assetId={selected.id}
                        containerRef={mobileTradesContainerRef}
                        density="compact"
                      />
                    </div>
                  ) : selectedPerp ? (
                    <div
                      ref={mobileTradesContainerRef}
                      className="h-full overflow-auto overscroll-contain"
                    >
                      <AssetTradesFeed
                        marketType="perp"
                        assetId={selectedPerp.ticker}
                        containerRef={mobileTradesContainerRef}
                        density="compact"
                      />
                    </div>
                  ) : (
                    <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
                      Select a market to see trades.
                    </div>
                  )
                ) : null}
              </div>
            </div>
          )}

          {isMobileMarketListOpen && (
            <div className="fade-in slide-in-from-bottom-2 fixed inset-0 z-[70] flex animate-in flex-col bg-background pt-safe duration-200">
              <div className="flex items-center justify-between border-white/5 border-b px-3">
                <h2 className="font-bold text-lg">Markets</h2>
                <button
                  type="button"
                  onClick={() => setIsMobileMarketListOpen(false)}
                  className="rounded-full p-2 transition-colors hover:bg-muted/20"
                  aria-label="Close markets list"
                >
                  <X size={20} />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">{listPanel}</div>
            </div>
          )}

          {isMobileTradeSheetOpen && (
            <div className="fixed inset-0 z-[70] flex flex-col justify-end">
              <button
                type="button"
                aria-label="Close trade sheet"
                className="absolute inset-0 bg-black/50 backdrop-blur-sm"
                onClick={() => setIsMobileTradeSheetOpen(false)}
              />
              <div className="slide-in-from-bottom-2 relative z-10 flex max-h-[85vh] w-full animate-in flex-col rounded-t-2xl border-white/5 border-t bg-background/95 shadow-2xl duration-200">
                <div className="flex items-center justify-between border-white/5 border-b p-4">
                  <h2 className="font-bold text-lg">Trade</h2>
                  <button
                    type="button"
                    onClick={() => setIsMobileTradeSheetOpen(false)}
                    className="rounded-full p-2 transition-colors hover:bg-muted/20"
                    aria-label="Close trade sheet"
                  >
                    <X size={20} />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {rightPanel}
                </div>
              </div>
            </div>
          )}

          {isMobileChartFullscreen && (
            <div className="fixed inset-0 z-[80] bg-background">
              <button
                type="button"
                aria-label="Close fullscreen chart"
                onClick={() => setIsMobileChartFullscreen(false)}
                className={cn(
                  "absolute top-[calc(12px+env(safe-area-inset-top))] right-[calc(12px+env(safe-area-inset-right))] z-20 inline-flex h-10 w-10 items-center justify-center rounded-full",
                  "border border-white/10 bg-background/70 text-muted-foreground shadow-sm backdrop-blur-md",
                  "transition-colors hover:bg-muted/40 hover:text-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
                )}
              >
                <X size={18} />
              </button>

              <div className="flex h-full flex-col pt-safe pb-safe">
                {selected?.kind === "prediction" ? (
                  <>
                    <PredictionMarketHeader
                      predictionState={predictionState}
                      yesPct={predictionYesPct}
                      timeRange={predictionTimeRange}
                      onTimeRangeChange={setPredictionTimeRange}
                      onDetailsClick={() => setPredictionDetailsOpen(true)}
                      variant="compact"
                    />
                    <div className="min-h-0 flex-1 p-2">
                      <PredictionProbabilityChart
                        data={predictionHistory}
                        marketId={selectedPredictionId ?? "unknown"}
                        timeRange={predictionTimeRange}
                        onTimeRangeChange={setPredictionTimeRange}
                        showHeader={false}
                        height="fill"
                      />
                    </div>
                  </>
                ) : selectedPerp ? (
                  <>
                    <PerpMarketHeader
                      selectedPerp={selectedPerp}
                      timeRange={perpTimeRange}
                      onTimeRangeChange={setPerpTimeRange}
                      variant="compact"
                    />
                    <div className="min-h-0 flex-1 p-2">
                      <PerpPriceChart
                        data={perpHistory.map((p) => ({
                          time: p.time,
                          price: p.price,
                        }))}
                        currentPrice={selectedPerp.currentPrice}
                        ticker={selectedPerp.ticker}
                        timeRange={perpTimeRange}
                        onTimeRangeChange={setPerpTimeRange}
                        showHeader={false}
                        height="fill"
                        className="h-full"
                      />
                    </div>
                  </>
                ) : (
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                    Select a market
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <AlertDialog
        open={predictionDetailsOpen}
        onOpenChange={setPredictionDetailsOpen}
      >
        <AlertDialogContent className="max-w-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Market details</AlertDialogTitle>
            <AlertDialogDescription>
              {predictionState?.text ?? "Prediction market"}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="mt-4 space-y-3 text-sm">
            {predictionState?.resolutionDescription?.trim() && (
              <div className="rounded border border-white/10 bg-muted/10 p-3">
                <div className="mb-1 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                  Conditions
                </div>
                <div className="whitespace-pre-wrap break-words text-foreground">
                  {predictionState.resolutionDescription}
                </div>
              </div>
            )}

            <div className="rounded border border-white/10 bg-muted/10 p-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Scenario</span>
                <span className="font-mono text-foreground tabular-nums">
                  {predictionState?.scenario ?? "—"}
                </span>
              </div>
              {formatDate(
                predictionState?.endDate ?? predictionState?.resolutionDate,
              ) && (
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-muted-foreground">Ends</span>
                  <span className="font-mono text-foreground tabular-nums">
                    {formatDate(
                      predictionState?.endDate ??
                        predictionState?.resolutionDate,
                    )}
                  </span>
                </div>
              )}
            </div>

            {predictionState?.resolutionProofUrl && (
              <a
                className="text-primary text-sm hover:underline"
                href={predictionState.resolutionProofUrl}
                target="_blank"
                rel="noreferrer"
              >
                View proof / source
              </a>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPredictionDetailsOpen(false)}>
              Close
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => setPredictionDetailsOpen(false)}>
              OK
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <TradeConfirmationDialog
        open={confirmDialogOpen}
        onOpenChange={setConfirmDialogOpen}
        onConfirm={handleConfirmPredictionTrade}
        isSubmitting={predictionSubmitting}
        tradeDetails={
          predictionState &&
          predictionTradeMode === "buy" &&
          predictionBuyCalculation
            ? ({
                type: "buy-prediction",
                question: predictionState.text,
                side: predictionSide.toUpperCase() as "YES" | "NO",
                amount: predictionAmountNum,
                sharesBought: predictionBuyCalculation.sharesBought,
                avgPrice: predictionBuyCalculation.avgPrice,
                newPrice:
                  predictionSide === "yes"
                    ? predictionBuyCalculation.newYesPrice
                    : predictionBuyCalculation.newNoPrice,
                priceImpact: predictionBuyCalculation.priceImpact,
                expectedPayout,
                expectedProfit,
              } satisfies BuyPredictionDetails)
            : predictionState &&
                predictionTradeMode === "sell" &&
                predictionSellCalculation &&
                sellPosition
              ? (() => {
                  const expectedValue =
                    predictionSellCalculation.netProceeds ??
                    predictionSellCalculation.netAmount ??
                    predictionSellCalculation.totalCost;
                  const costBasis =
                    typeof sellPosition.costBasis === "number" &&
                    sellPosition.shares > 0
                      ? sellPosition.costBasis *
                        (clampedSellShares / sellPosition.shares)
                      : clampedSellShares * sellPosition.avgPrice;
                  const unrealizedPnL = expectedValue - costBasis;
                  const unrealizedPnLPercent =
                    costBasis !== 0 ? (unrealizedPnL / costBasis) * 100 : 0;
                  const currentPrice =
                    sellPosition.currentPrice ??
                    (clampedSellShares > 0
                      ? expectedValue / clampedSellShares
                      : 0);

                  return {
                    type: "sell-prediction",
                    question: predictionState.text,
                    side: predictionSide.toUpperCase() as "YES" | "NO",
                    shares: clampedSellShares,
                    avgPrice: sellPosition.avgPrice,
                    currentPrice,
                    expectedValue,
                    unrealizedPnL,
                    unrealizedPnLPercent,
                  } satisfies SellPredictionDetails;
                })()
              : null
        }
      />

      <SpotlightTutorial
        isActive={tutorial.isActive}
        currentStep={tutorial.currentStep}
        steps={tutorial.steps}
        next={tutorial.next}
        prev={tutorial.prev}
        dismiss={tutorial.dismiss}
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
  disabled,
  soon,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  soon?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-2 font-semibold text-xs transition-colors",
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground",
        disabled && "cursor-not-allowed opacity-60 hover:text-muted-foreground",
      )}
    >
      {children}
      {soon && (
        <span className="rounded-full bg-muted/20 px-2 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wider">
          Soon
        </span>
      )}
    </button>
  );
}
