"use client";

import { cn } from "@feed/shared";
import { BarChart2, Bell, Home, Trophy, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Panel,
  Group as PanelGroup,
  Separator as PanelResizeHandle,
} from "react-resizable-panels";
import { Avatar } from "@/components/shared/Avatar";
import { MarketsToggle } from "@/components/shared/MarketsToggle";
import { Skeleton } from "@/components/shared/Skeleton";
import { useAuth } from "@/hooks/useAuth";
import {
  usePerpMarkets,
  usePerpMarketsRealtime,
} from "@/stores/perpMarketsStore";
import { useUserPositionsPolling } from "@/stores/userPositionsStore";
import {
  useWalletBalance,
  useWalletBalancePolling,
} from "@/stores/walletBalanceStore";
import type { MarketTab, PerpMarket } from "@/types/markets";
import { PerpsMarketDetailPanel } from "./PerpsMarketDetailPanel";
import { PerpsMarketListPanel } from "./PerpsMarketListPanel";
import { PerpsOrderEntryPanel } from "./PerpsOrderEntryPanel";
import {
  PerpsTerminalBottomPanel,
  type PerpsTerminalBottomTab,
} from "./PerpsTerminalBottomPanel";

interface PerpsTradingTerminalProps {
  activeTab: MarketTab;
  onTabChange: (tab: MarketTab) => void;
}

function pickDefaultMarket(markets: PerpMarket[]): PerpMarket | null {
  if (markets.length === 0) return null;
  const sorted = [...markets].sort(
    (a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0),
  );
  return sorted[0] ?? null;
}

export function PerpsTradingTerminal({
  activeTab,
  onTabChange,
}: PerpsTradingTerminalProps) {
  const { user, authenticated } = useAuth();
  const { markets, loading, error } = usePerpMarkets();
  usePerpMarketsRealtime();

  const userId = authenticated ? (user?.id ?? null) : null;
  useUserPositionsPolling(userId);
  useWalletBalancePolling(userId);

  const { balance, loading: balanceLoading } = useWalletBalance(userId);

  const [activeTicker, setActiveTicker] = useState<string | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [bottomCollapsed, setBottomCollapsed] = useState(false);
  const [bottomTab, setBottomTab] =
    useState<PerpsTerminalBottomTab>("positions");

  const [isMobileMarketListOpen, setIsMobileMarketListOpen] = useState(false);
  const [isMobileOrderSheetOpen, setIsMobileOrderSheetOpen] = useState(false);
  const [activeMobileTab, setActiveMobileTab] =
    useState<PerpsTerminalBottomTab>("positions");

  const fallbackMarket = useMemo(() => pickDefaultMarket(markets), [markets]);

  useEffect(() => {
    if (activeTicker) return;
    if (!fallbackMarket) return;
    setActiveTicker(fallbackMarket.ticker);
  }, [activeTicker, fallbackMarket]);

  const activeMarket = useMemo(() => {
    if (!activeTicker) return null;
    return (
      markets.find(
        (m) => m.ticker.toLowerCase() === activeTicker.toLowerCase(),
      ) ?? null
    );
  }, [markets, activeTicker]);

  const pathname = usePathname();

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      {/* -------------------- DESKTOP LAYOUT (Hidden on Mobile) -------------------- */}
      <div className="hidden min-h-0 flex-1 flex-col md:flex">
        {/* Terminal header (keeps app navigation coherent while matching terminal density) */}
        <div className="flex h-10 shrink-0 items-center justify-between border-white/5 border-b bg-background/40 px-3 backdrop-blur-md">
          <div className="flex min-w-0 flex-1 items-center">
            <div className="min-w-0 flex-1">
              <MarketsToggle
                activeTab={activeTab}
                onTabChange={onTabChange}
                balance={balance}
                authenticated={authenticated}
                loading={balanceLoading}
              />
            </div>
          </div>

          <div className="ml-3 hidden items-center gap-2 text-muted-foreground text-xs lg:flex">
            <button
              type="button"
              onClick={() => setLeftCollapsed((v) => !v)}
              className="rounded border border-white/10 bg-background/30 px-2 py-1 transition-colors hover:bg-muted/20 hover:text-foreground"
            >
              {leftCollapsed ? "Show markets" : "Hide markets"}
            </button>
            <button
              type="button"
              onClick={() => setRightCollapsed((v) => !v)}
              className="rounded border border-white/10 bg-background/30 px-2 py-1 transition-colors hover:bg-muted/20 hover:text-foreground"
            >
              {rightCollapsed ? "Show trade" : "Hide trade"}
            </button>
            <button
              type="button"
              onClick={() => setBottomCollapsed((v) => !v)}
              className="rounded border border-white/10 bg-background/30 px-2 py-1 transition-colors hover:bg-muted/20 hover:text-foreground"
            >
              {bottomCollapsed ? "Show bottom" : "Hide bottom"}
            </button>
          </div>
        </div>

        {/* Terminal body */}
        <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
          {/* Left collapsed strip */}
          {leftCollapsed && (
            <button
              type="button"
              onClick={() => setLeftCollapsed(false)}
              className="w-9 shrink-0 border-white/5 border-r bg-background/30 text-muted-foreground transition-colors hover:bg-muted/20 hover:text-foreground"
              aria-label="Open markets panel"
            >
              <div className="flex h-full flex-col items-center justify-center gap-3">
                <div className="h-6 w-6 rounded bg-muted/30" />
                <span className="writing-vertical-lr rotate-180 font-semibold text-[10px] tracking-wider">
                  MARKETS
                </span>
              </div>
            </button>
          )}

          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <PanelGroup orientation="vertical" className="flex min-h-0 flex-1">
              <Panel
                defaultSize={bottomCollapsed ? 100 : 70}
                minSize={35}
                className="min-h-0"
              >
                <PanelGroup orientation="horizontal" className="min-h-0">
                  {/* Left: Markets list */}
                  {!leftCollapsed && (
                    <>
                      <Panel
                        defaultSize={22}
                        minSize={15}
                        maxSize={32}
                        className="min-h-0 border-white/5 border-r"
                      >
                        <div className="flex h-full min-h-0 flex-col bg-background/20">
                          {loading ? (
                            <div className="p-3">
                              <Skeleton className="h-8 w-full" />
                              <div className="mt-3 space-y-2">
                                <Skeleton className="h-10 w-full" />
                                <Skeleton className="h-10 w-full" />
                                <Skeleton className="h-10 w-full" />
                              </div>
                            </div>
                          ) : error ? (
                            <div className="p-4 text-muted-foreground text-sm">
                              Failed to load markets.
                            </div>
                          ) : (
                            <PerpsMarketListPanel
                              markets={markets}
                              activeTicker={activeTicker}
                              onSelectTicker={setActiveTicker}
                              onCollapse={() => setLeftCollapsed(true)}
                            />
                          )}
                        </div>
                      </Panel>
                      <PanelResizeHandle className="w-1 bg-white/5 hover:bg-primary/40" />
                    </>
                  )}

                  {/* Center: Market detail + chart */}
                  <Panel
                    defaultSize={leftCollapsed ? 72 : 56}
                    minSize={40}
                    className="min-h-0"
                  >
                    <div className="h-full min-h-0 bg-background/10">
                      <PerpsMarketDetailPanel market={activeMarket} />
                    </div>
                  </Panel>

                  {/* Right: Order entry */}
                  {!rightCollapsed && (
                    <>
                      <PanelResizeHandle className="w-1 bg-white/5 hover:bg-primary/40" />
                      <Panel
                        defaultSize={22}
                        minSize={18}
                        maxSize={32}
                        className="min-h-0 border-white/5 border-l bg-background/20"
                      >
                        <PerpsOrderEntryPanel market={activeMarket} />
                      </Panel>
                    </>
                  )}

                  {/* Right collapsed strip */}
                  {rightCollapsed && (
                    <button
                      type="button"
                      onClick={() => setRightCollapsed(false)}
                      className="w-9 shrink-0 border-white/5 border-l bg-background/30 text-muted-foreground transition-colors hover:bg-muted/20 hover:text-foreground"
                      aria-label="Open trade panel"
                    >
                      <div className="flex h-full flex-col items-center justify-center gap-3">
                        <div className="h-6 w-6 rounded bg-muted/30" />
                        <span className="writing-vertical-lr rotate-180 font-semibold text-[10px] tracking-wider">
                          TRADE
                        </span>
                      </div>
                    </button>
                  )}
                </PanelGroup>
              </Panel>

              {!bottomCollapsed && (
                <>
                  <PanelResizeHandle className="h-1 bg-white/5 hover:bg-primary/40" />
                  <Panel
                    defaultSize={30}
                    minSize={12}
                    className="min-h-0 border-white/5 border-t bg-background/20"
                  >
                    <PerpsTerminalBottomPanel
                      ticker={activeMarket?.ticker ?? null}
                      activeTab={bottomTab}
                      onTabChange={setBottomTab}
                      onCollapse={() => setBottomCollapsed(true)}
                    />
                  </Panel>
                </>
              )}
            </PanelGroup>

            {bottomCollapsed && (
              <button
                type="button"
                onClick={() => setBottomCollapsed(false)}
                className={cn(
                  "flex h-7 shrink-0 items-center justify-between border-white/5 border-t bg-background/40 px-4 text-muted-foreground",
                  "transition-colors hover:bg-muted/20 hover:text-foreground",
                )}
              >
                <span className="font-semibold text-[10px] tracking-widest">
                  POSITIONS & TRADES
                </span>
                <span className="text-[10px]">▲</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* -------------------- MOBILE LAYOUT (Visible on Mobile) -------------------- */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden md:hidden">
        <div className="shrink-0 border-white/5 border-b bg-background">
          <div className="flex h-14 items-center justify-between px-4">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-foreground text-background">
                <span className="font-bold text-xs">B</span>
              </div>
              <span className="font-bold text-lg tracking-tight">feed</span>
            </div>
            <button
              type="button"
              onClick={() => setIsMobileMarketListOpen(true)}
              className="flex items-center gap-2 rounded-full bg-muted px-3 py-1.5"
            >
              <span className="font-bold text-sm">
                {activeMarket?.ticker ?? "Select"}
              </span>
              <span className="text-muted-foreground text-xs">▼</span>
            </button>
          </div>
          <div className="px-3">
            <MarketsToggle
              activeTab={activeTab}
              onTabChange={onTabChange}
              balance={balance}
              authenticated={authenticated}
              loading={balanceLoading}
            />
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div className="hide-scrollbar flex h-full flex-col overflow-y-auto overflow-x-hidden">
            <div className="h-[45vh] w-full shrink-0 border-white/5 border-b">
              <PerpsMarketDetailPanel market={activeMarket} />
            </div>

            <div className="sticky top-0 z-30 flex h-12 shrink-0 items-center border-white/5 border-b bg-background px-2 shadow-sm">
              {(
                [
                  { id: "positions", label: "Positions", enabled: true },
                  { id: "orders", label: "Orders", enabled: false },
                  { id: "pnl", label: "PnL Analysis", enabled: false },
                  { id: "agent", label: "Agent", enabled: false },
                  { id: "socials", label: "Social", enabled: false },
                  { id: "trades", label: "Trades", enabled: true },
                ] as const
              ).map(({ id, label, enabled }) => {
                const isActive = activeMobileTab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    disabled={!enabled}
                    className={cn(
                      "relative flex h-full min-w-[88px] flex-1 items-center justify-center py-3 font-bold text-sm capitalize transition-colors",
                      isActive ? "text-foreground" : "text-muted-foreground",
                      !enabled && "cursor-not-allowed opacity-60",
                    )}
                    onClick={() => {
                      if (!enabled) return;
                      setActiveMobileTab(id);
                    }}
                  >
                    {label}
                    {isActive && (
                      <div className="absolute bottom-0 left-0 h-0.5 w-full rounded-t-full bg-foreground" />
                    )}
                    {!enabled && (
                      <span className="ml-2 rounded-full bg-muted/20 px-2 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                        Soon
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="min-h-[320px] flex-1">
              <PerpsTerminalBottomPanel
                ticker={activeMarket?.ticker ?? null}
                activeTab={activeMobileTab}
                onTabChange={setActiveMobileTab}
                hideHeader
              />
            </div>

            <div className="h-28 shrink-0" />
          </div>

          <div className="pointer-events-none absolute bottom-[calc(72px+env(safe-area-inset-bottom)+12px)] left-0 z-30 flex w-full justify-center px-4">
            <button
              type="button"
              onClick={() => setIsMobileOrderSheetOpen(true)}
              className="pointer-events-auto w-full max-w-sm rounded-full bg-foreground py-3.5 font-bold text-background shadow-lg transition-transform active:scale-95"
              disabled={!activeMarket}
            >
              Trade {activeMarket?.ticker ?? ""}
            </button>
          </div>

          <MobileBottomNav
            authenticated={authenticated}
            userId={user?.id ?? undefined}
            username={user?.username ?? user?.email ?? undefined}
            activePathname={pathname}
          />

          {isMobileMarketListOpen && (
            <div className="fade-in slide-in-from-bottom-2 absolute inset-0 z-50 flex animate-in flex-col bg-background duration-200">
              <div className="flex items-center justify-between border-white/5 border-b p-4">
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
              <div className="min-h-0 flex-1 overflow-hidden">
                {loading ? (
                  <div className="p-3">
                    <Skeleton className="h-8 w-full" />
                    <div className="mt-3 space-y-2">
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-10 w-full" />
                    </div>
                  </div>
                ) : error ? (
                  <div className="p-4 text-muted-foreground text-sm">
                    Failed to load markets.
                  </div>
                ) : (
                  <PerpsMarketListPanel
                    markets={markets}
                    activeTicker={activeTicker}
                    onSelectTicker={(ticker) => {
                      setActiveTicker(ticker);
                      setIsMobileMarketListOpen(false);
                    }}
                    onCollapse={() => setIsMobileMarketListOpen(false)}
                  />
                )}
              </div>
            </div>
          )}

          {isMobileOrderSheetOpen && (
            <div className="fixed inset-0 z-50 flex flex-col justify-end">
              <button
                type="button"
                aria-label="Close trade sheet"
                className="absolute inset-0 bg-black/50 backdrop-blur-sm"
                onClick={() => setIsMobileOrderSheetOpen(false)}
              />
              <div className="slide-in-from-bottom-2 relative z-10 flex max-h-[85vh] w-full animate-in flex-col rounded-t-2xl border-white/5 border-t bg-background/95 shadow-2xl duration-200">
                <div className="flex items-center justify-between border-white/5 border-b p-4">
                  <h2 className="font-bold text-lg">
                    Trade {activeMarket?.ticker ?? ""}
                  </h2>
                  <button
                    type="button"
                    onClick={() => setIsMobileOrderSheetOpen(false)}
                    className="rounded-full p-2 transition-colors hover:bg-muted/20"
                    aria-label="Close trade sheet"
                  >
                    <X size={20} />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <PerpsOrderEntryPanel market={activeMarket} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MobileBottomNav({
  authenticated,
  userId,
  username,
  activePathname,
}: {
  authenticated: boolean;
  userId?: string;
  username?: string;
  activePathname: string;
}) {
  const items = [
    {
      href: "/profile",
      key: "profile",
      label: "Profile",
      icon: (
        <div className="h-6 w-6">
          <Avatar
            id={authenticated ? userId : undefined}
            name={username}
            type="user"
            size="sm"
            className="h-6 w-6"
          />
        </div>
      ),
    },
    { href: "/", key: "home", label: "Home", icon: <Home size={22} /> },
    {
      href: "/notifications",
      key: "notifications",
      label: "Notifications",
      icon: <Bell size={22} />,
    },
    {
      href: "/leaderboard",
      key: "leaderboard",
      label: "Leaderboard",
      icon: <Trophy size={22} />,
    },
    {
      href: "/markets",
      key: "markets",
      label: "Markets",
      icon: <BarChart2 size={22} strokeWidth={2.5} />,
    },
  ] as const;

  return (
    <div className="relative z-40 flex h-[72px] select-none items-center justify-between rounded-t-[20px] border-white/5 border-t bg-background px-2 pb-safe font-medium text-[10px] text-muted-foreground shadow-[0_-5px_15px_rgba(0,0,0,0.12)]">
      {items.map((item) => {
        const isActive =
          item.href === "/markets"
            ? activePathname.startsWith("/markets")
            : activePathname === item.href;
        return (
          <Link
            key={item.key}
            href={item.href}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-1 py-1 transition-colors",
              isActive ? "font-bold text-foreground" : "hover:text-foreground",
            )}
          >
            {item.icon}
            <span className="scale-90">{item.label}</span>
          </Link>
        );
      })}
    </div>
  );
}
