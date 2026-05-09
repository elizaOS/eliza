import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Button, cn, PageLayout, SidebarContent, SidebarPanel, SidebarScrollRegion, } from "@elizaos/ui";
import { Activity, ArrowDownLeft, ArrowLeftRight, BarChart3, Copy, EyeOff, Image as ImageIcon, Layers3, RefreshCw, Send, Sparkles, TrendingDown, TrendingUp, Wallet, } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, } from "react";
import { client } from "@elizaos/app-core";
import { useActivityEvents, } from "@elizaos/ui";
import { useApp } from "@elizaos/ui";
import { AppPageSidebar } from "@elizaos/ui";
import { getNativeLogoUrl } from "./inventory/chainConfig";
import { formatBalance, } from "./inventory/constants";
import { TokenLogo } from "./inventory/TokenLogo";
import { useInventoryData } from "./inventory/useInventoryData";
const ALL_INVENTORY_FILTERS = {
    ethereum: true,
    base: true,
    bsc: true,
    avax: true,
    solana: true,
};
const SUPPORTED_WALLET_CHAINS = Object.keys(ALL_INVENTORY_FILTERS);
const DASHBOARD_WINDOWS = ["24h", "7d", "30d"];
const HIDDEN_TOKEN_IDS_KEY = "eliza:wallet:hidden-token-ids:v1";
const WALLET_CHAT_PREFILL_EVENT = "eliza:chat:prefill";
const WALLET_SIDEBAR_WIDTH_KEY = "eliza:wallets:sidebar:width";
const WALLET_SIDEBAR_COLLAPSED_KEY = "eliza:wallets:sidebar:collapsed";
const WALLET_SIDEBAR_DEFAULT_WIDTH = 352;
const WALLET_SIDEBAR_MIN_WIDTH = 240;
const WALLET_SIDEBAR_MAX_WIDTH = 520;
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
function resolveWalletAddresses({ walletAddresses, walletConfig, }) {
    return {
        evmAddress: walletAddresses?.evmAddress ?? walletConfig?.evmAddress ?? null,
        solanaAddress: walletAddresses?.solanaAddress ?? walletConfig?.solanaAddress ?? null,
    };
}
function readHiddenTokenIds() {
    if (typeof window === "undefined")
        return new Set();
    try {
        const raw = window.localStorage.getItem(HIDDEN_TOKEN_IDS_KEY);
        if (!raw)
            return new Set();
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return new Set();
        return new Set(parsed.filter((item) => typeof item === "string"));
    }
    catch {
        return new Set();
    }
}
function writeHiddenTokenIds(next) {
    if (typeof window === "undefined")
        return;
    try {
        window.localStorage.setItem(HIDDEN_TOKEN_IDS_KEY, JSON.stringify([...next]));
    }
    catch {
        return;
    }
}
function tokenId(row) {
    const address = row.contractAddress && row.contractAddress.length > 0
        ? row.contractAddress.toLowerCase()
        : `native:${row.symbol.toLowerCase()}`;
    return `${row.chain.toLowerCase()}:${address}`;
}
function normalizeTokenAddress(address) {
    return address ? address.toLowerCase() : null;
}
function formatUsd(value) {
    if (!Number.isFinite(value))
        return usdFormatter.format(0);
    return usdFormatter.format(value);
}
function formatCompactUsd(value) {
    if (!Number.isFinite(value))
        return compactDollarFormatter.format(0);
    return compactDollarFormatter.format(value);
}
function formatMarketUsd(value) {
    if (!Number.isFinite(value))
        return usdFormatter.format(0);
    const fractionDigits = value >= 1_000 ? 0 : value >= 1 ? 2 : value >= 0.01 ? 4 : 6;
    const minimumFractionDigits = value >= 1 ? Math.min(2, fractionDigits) : 0;
    return value.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits,
        maximumFractionDigits: fractionDigits,
    });
}
function formatPercentDelta(value) {
    if (!Number.isFinite(value))
        return "0.0%";
    const magnitude = Math.abs(value).toLocaleString("en-US", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
    });
    const sign = value > 0 ? "+" : value < 0 ? "-" : "";
    return `${sign}${magnitude}%`;
}
function formatProbability(value) {
    if (value === null || !Number.isFinite(value))
        return "No odds";
    return `${Math.round(value * 100)}%`;
}
function formatBnb(value) {
    if (!value)
        return "0 BNB";
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed))
        return `${value} BNB`;
    return `${compactFormatter.format(parsed)} BNB`;
}
function parseAmount(value) {
    if (!value)
        return null;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function formatSignedBnb(value) {
    const sign = value > 0 ? "+" : value < 0 ? "-" : "";
    return `${sign}${compactFormatter.format(Math.abs(value))} BNB`;
}
function hasClosedTradePnl(profile) {
    return (profile?.summary.evaluatedTrades ?? 0) > 0;
}
function clampWalletSidebarWidth(value) {
    return Math.min(Math.max(value, WALLET_SIDEBAR_MIN_WIDTH), WALLET_SIDEBAR_MAX_WIDTH);
}
function loadInitialWalletSidebarWidth() {
    if (typeof window === "undefined")
        return WALLET_SIDEBAR_DEFAULT_WIDTH;
    try {
        const raw = window.localStorage.getItem(WALLET_SIDEBAR_WIDTH_KEY);
        const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
        if (Number.isFinite(parsed))
            return clampWalletSidebarWidth(parsed);
    }
    catch {
        /* ignore sandboxed storage */
    }
    return WALLET_SIDEBAR_DEFAULT_WIDTH;
}
function loadInitialWalletSidebarCollapsed() {
    if (typeof window === "undefined")
        return false;
    try {
        return window.localStorage.getItem(WALLET_SIDEBAR_COLLAPSED_KEY) === "true";
    }
    catch {
        return false;
    }
}
function useWalletSidebarDesktopMode() {
    const [isDesktop, setIsDesktop] = useState(() => {
        if (typeof window === "undefined" ||
            typeof window.matchMedia !== "function") {
            return true;
        }
        return window.matchMedia("(min-width: 820px)").matches;
    });
    useEffect(() => {
        if (typeof window === "undefined" ||
            typeof window.matchMedia !== "function") {
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
function providerLabel(provider, chain) {
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
function formatRelativeTimestamp(timestamp) {
    const diff = Date.now() - timestamp;
    if (diff < 0)
        return "now";
    if (diff < 60_000)
        return "just now";
    if (diff < 3_600_000)
        return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000)
        return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 604_800_000)
        return `${Math.floor(diff / 86_400_000)}d ago`;
    return new Date(timestamp).toLocaleDateString();
}
function formatMarketEndsAt(value) {
    if (!value)
        return null;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp))
        return null;
    return new Date(timestamp).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
    });
}
function tradingProfileWindow(window) {
    return window === "24h" ? "24h" : window;
}
function tokenHasInventory(row) {
    return row.balanceRaw > 0 || row.valueUsd > 0;
}
function assetAllocationRows(rows) {
    return rows
        .filter((row) => row.valueUsd > 0)
        .sort((left, right) => right.valueUsd - left.valueUsd)
        .slice(0, 5);
}
function looksLikeLpPosition(value) {
    const text = ` ${value.toLowerCase()} `;
    return (text.includes(" liquidity ") ||
        text.includes(" lp ") ||
        text.includes("-lp") ||
        text.includes("/lp") ||
        text.includes(" pool ") ||
        text.includes(" position ") ||
        text.includes(" clmm ") ||
        text.includes(" amm "));
}
function deriveInventoryPositionAssets({ tokenRows, nfts, }) {
    const positions = [];
    for (const row of tokenRows) {
        if (!looksLikeLpPosition(`${row.name} ${row.symbol}`))
            continue;
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
        if (!looksLikeLpPosition(`${nft.collectionName} ${nft.name}`))
            continue;
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
function dispatchWalletChatPrefill(text) {
    window.dispatchEvent(new CustomEvent(WALLET_CHAT_PREFILL_EVENT, {
        detail: { text, select: true },
    }));
}
function tokenBreakdownForRow(row, profile) {
    const normalizedAddress = normalizeTokenAddress(row.contractAddress);
    if (!normalizedAddress || !profile)
        return null;
    return (profile.tokenBreakdown.find((item) => item.tokenAddress.toLowerCase() === normalizedAddress) ?? null);
}
function portfolioMovers(rows, profile) {
    if (!profile)
        return [];
    return rows
        .map((row) => {
        const breakdown = tokenBreakdownForRow(row, profile);
        const realizedPnlBnb = parseAmount(breakdown?.realizedPnlBnb);
        if (realizedPnlBnb === null || realizedPnlBnb === 0)
            return null;
        return {
            row,
            realizedPnlBnb,
        };
    })
        .filter((mover) => mover !== null);
}
function TokenPerformance({ row, profile, maxAbsPnl, }) {
    const breakdown = tokenBreakdownForRow(row, profile);
    if (!breakdown) {
        return null;
    }
    const pnl = parseAmount(breakdown.realizedPnlBnb);
    if (pnl === null)
        return null;
    const width = maxAbsPnl > 0 ? Math.max(18, (Math.abs(pnl) / maxAbsPnl) * 56) : 18;
    const TrendIcon = pnl >= 0 ? TrendingUp : TrendingDown;
    const tone = pnl === 0 ? "text-muted" : pnl > 0 ? "text-ok" : "text-danger";
    const barTone = pnl === 0 ? "bg-border" : pnl > 0 ? "bg-ok/80" : "bg-danger/80";
    return (_jsxs("span", { className: "flex min-w-[4.5rem] flex-col items-end gap-1", children: [_jsxs("span", { className: cn("inline-flex items-center gap-1 text-[0.68rem] font-medium", tone), children: [_jsx(TrendIcon, { className: "h-3 w-3" }), pnl > 0 ? "+" : "", formatBnb(breakdown.realizedPnlBnb)] }), _jsx("span", { className: "flex h-1.5 w-14 justify-end overflow-hidden rounded-full bg-border/45", "aria-hidden": "true", children: _jsx("span", { className: cn("h-full rounded-full", barTone), style: { width } }) })] }));
}
function maxAbsTokenPnl(rows, profile) {
    if (!profile)
        return 0;
    let max = 0;
    for (const row of rows) {
        const breakdown = tokenBreakdownForRow(row, profile);
        const pnl = parseAmount(breakdown?.realizedPnlBnb);
        if (pnl !== null)
            max = Math.max(max, Math.abs(pnl));
    }
    return max;
}
function ChainLogoBadge({ chain, size = 18, className, }) {
    const [errored, setErrored] = useState(false);
    const logoUrl = errored ? null : getNativeLogoUrl(chain);
    return (_jsx("span", { className: cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-bg shadow-sm ring-2 ring-bg", className), style: { width: size, height: size }, title: chain, role: "img", "aria-label": chain, children: logoUrl ? (_jsx("img", { src: logoUrl, alt: "", className: "h-full w-full object-cover", onError: () => setErrored(true) })) : (_jsx("span", { className: "font-mono text-[0.58rem] font-bold uppercase text-muted", children: chain.charAt(0) })) }));
}
function TokenIdentityIcon({ row, size = 46, }) {
    const badgeSize = Math.max(16, Math.round(size * 0.38));
    return (_jsxs("span", { className: "relative inline-flex shrink-0", style: { width: size, height: size }, children: [_jsx(TokenLogo, { symbol: row.symbol, chain: row.chain, contractAddress: row.contractAddress, preferredLogoUrl: row.logoUrl, size: size }), _jsx(ChainLogoBadge, { chain: row.chain, size: badgeSize, className: "-bottom-0.5 -right-0.5 absolute" })] }));
}
function allocationToneClass(index) {
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
function AssetAllocationStrip({ rows, compact = false, }) {
    const allocationRows = useMemo(() => assetAllocationRows(rows), [rows]);
    const total = allocationRows.reduce((sum, row) => sum + row.valueUsd, 0);
    if (total <= 0 || allocationRows.length === 0)
        return null;
    return (_jsxs("div", { className: cn("space-y-2", compact && "space-y-3"), children: [_jsx("div", { className: cn("flex overflow-hidden rounded-full bg-border/40", compact ? "h-2.5" : "h-2"), children: allocationRows.map((row, index) => (_jsx("span", { className: cn("h-full", allocationToneClass(index)), style: { width: `${(row.valueUsd / total) * 100}%` }, title: `${row.symbol}: ${formatUsd(row.valueUsd)}` }, tokenId(row)))) }), compact ? (_jsx("div", { className: "flex flex-wrap gap-2", children: allocationRows.slice(0, 3).map((row, index) => (_jsxs("div", { className: "inline-flex items-center gap-1.5 rounded-full border border-border/35 bg-bg/35 px-2.5 py-1 text-[0.68rem] font-medium text-txt", children: [_jsx("span", { className: cn("h-1.5 w-1.5 rounded-full", allocationToneClass(index)) }), _jsx("span", { children: row.symbol })] }, tokenId(row)))) })) : (_jsx("div", { className: "grid gap-1", children: allocationRows.slice(0, 3).map((row) => (_jsxs("div", { className: "flex items-center justify-between gap-2 text-[0.68rem]", children: [_jsx("span", { className: "truncate text-muted", children: row.symbol }), _jsx("span", { className: "shrink-0 font-mono text-txt", children: formatUsd(row.valueUsd) })] }, tokenId(row)))) }))] }));
}
function PortfolioMoverRow({ mover, maxAbsPnl, }) {
    const isGain = mover.realizedPnlBnb > 0;
    const width = maxAbsPnl > 0
        ? Math.max(18, (Math.abs(mover.realizedPnlBnb) / maxAbsPnl) * 100)
        : 18;
    return (_jsxs("div", { className: "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl bg-bg/35 px-3 py-2.5", children: [_jsx(TokenIdentityIcon, { row: mover.row, size: 34 }), _jsxs("div", { className: "min-w-0", children: [_jsx("div", { className: "truncate text-sm font-semibold text-txt", children: mover.row.symbol }), _jsx("div", { className: "mt-1 h-1.5 overflow-hidden rounded-full bg-border/45", children: _jsx("div", { className: cn("h-full rounded-full", isGain ? "bg-ok/85" : "bg-danger/85"), style: { width: `${width}%` } }) })] }), _jsx("div", { className: cn("shrink-0 text-right font-mono text-xs font-semibold", isGain ? "text-ok" : "text-danger"), children: formatSignedBnb(mover.realizedPnlBnb) })] }));
}
function PortfolioMoverColumn({ title, movers, maxAbsPnl, tone, }) {
    return (_jsxs("div", { className: "min-w-0 space-y-2", children: [_jsxs("div", { className: "flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted", children: [tone === "gain" ? (_jsx(TrendingUp, { className: "h-3.5 w-3.5 text-ok" })) : (_jsx(TrendingDown, { className: "h-3.5 w-3.5 text-danger" })), title] }), movers.length > 0 ? (_jsx("div", { className: "space-y-2", children: movers.map((mover) => (_jsx(PortfolioMoverRow, { mover: mover, maxAbsPnl: maxAbsPnl }, `${tokenId(mover.row)}:${mover.realizedPnlBnb}`))) })) : (_jsx("div", { className: "flex h-[3.75rem] items-center rounded-2xl bg-bg/25 px-3 text-xs-tight text-muted", children: "None" }))] }));
}
function PortfolioMoversPanel({ rows, profile, marketOverview, }) {
    const movers = useMemo(() => portfolioMovers(rows, profile), [rows, profile]);
    const gainers = useMemo(() => movers
        .filter((mover) => mover.realizedPnlBnb > 0)
        .sort((left, right) => right.realizedPnlBnb - left.realizedPnlBnb)
        .slice(0, 3), [movers]);
    const losers = useMemo(() => movers
        .filter((mover) => mover.realizedPnlBnb < 0)
        .sort((left, right) => left.realizedPnlBnb - right.realizedPnlBnb)
        .slice(0, 3), [movers]);
    const maxAbsPnl = useMemo(() => movers.reduce((max, mover) => Math.max(max, Math.abs(mover.realizedPnlBnb)), 0), [movers]);
    if (movers.length === 0) {
        if (marketOverview?.movers.length) {
            return (_jsxs("div", { className: "space-y-3", children: [_jsx("div", { className: "text-xs font-semibold uppercase tracking-[0.12em] text-muted", children: "Market-wide" }), _jsx(MarketMoverList, { movers: marketOverview.movers, source: marketOverview.sources.movers })] }));
        }
        return _jsx(EmptyState, { icon: TrendingUp, title: "No movers yet" });
    }
    return (_jsxs("div", { className: "grid gap-4 md:grid-cols-2", children: [_jsx(PortfolioMoverColumn, { title: "Gainers", movers: gainers, maxAbsPnl: maxAbsPnl, tone: "gain" }), _jsx(PortfolioMoverColumn, { title: "Losers", movers: losers, maxAbsPnl: maxAbsPnl, tone: "loss" })] }));
}
function EmptyState({ icon: Icon, title, body, }) {
    return (_jsxs("div", { className: "flex min-h-[8rem] flex-col items-center justify-center rounded-2xl bg-bg/30 px-4 py-6 text-center", children: [_jsx(Icon, { className: "mb-3 h-5 w-5 text-muted" }), _jsx("div", { className: "text-sm font-semibold text-txt", children: title }), body ? (_jsx("div", { className: "mt-1 max-w-sm text-xs-tight text-muted", children: body })) : null] }));
}
function MarketAvatar({ imageUrl, label, }) {
    if (imageUrl) {
        return (_jsx("img", { src: imageUrl, alt: label, className: "h-11 w-11 shrink-0 rounded-2xl object-cover", loading: "lazy" }));
    }
    return (_jsx("div", { className: "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-bg/65 text-sm font-semibold text-txt", children: label.slice(0, 1).toUpperCase() }));
}
function MarketSourceBadge({ source }) {
    return (_jsx("a", { href: source.providerUrl, target: "_blank", rel: "noreferrer", className: "transition-opacity hover:opacity-80", children: _jsx("span", { className: "inline-flex items-center rounded-full border border-border/35 bg-bg/45 px-2.5 py-1 text-[0.68rem] font-semibold text-txt", children: source.providerName }) }));
}
function MarketSectionHeader({ icon: Icon, title, source, }) {
    return (_jsxs("div", { className: "mb-3 flex flex-wrap items-center gap-2 text-sm font-semibold text-txt", children: [_jsx(Icon, { className: "h-4 w-4 text-accent" }), _jsx("span", { children: title }), _jsx(MarketSourceBadge, { source: source })] }));
}
function MarketDataUnavailable({ title, source, }) {
    return (_jsxs("div", { className: "rounded-2xl border border-danger/20 bg-danger/10 px-4 py-3", children: [_jsxs("div", { className: "text-sm font-semibold text-danger", children: [title, " unavailable"] }), _jsx("div", { className: "mt-1 text-xs text-danger/80", children: source.error ?? `${source.providerName} did not return live data.` })] }));
}
function MajorPriceCard({ snapshot }) {
    const isPositive = snapshot.change24hPct >= 0;
    return (_jsxs("div", { className: "min-w-0 rounded-[26px] border border-border/30 bg-bg/40 p-4", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(MarketAvatar, { imageUrl: snapshot.imageUrl, label: snapshot.symbol }), _jsxs("div", { className: "min-w-0", children: [_jsx("div", { className: "text-xs font-semibold uppercase tracking-[0.12em] text-muted", children: snapshot.symbol }), _jsx("div", { className: "truncate text-sm font-medium text-txt", children: snapshot.name })] })] }), _jsxs("div", { className: "mt-4 flex flex-wrap items-end justify-between gap-x-3 gap-y-1", children: [_jsx("div", { className: "min-w-0 font-mono text-lg font-semibold text-txt sm:text-xl", children: formatMarketUsd(snapshot.priceUsd) }), _jsx("div", { className: cn("shrink-0 text-sm font-semibold", isPositive ? "text-ok" : "text-danger"), children: formatPercentDelta(snapshot.change24hPct) })] })] }));
}
function MarketPriceGrid({ prices, source, }) {
    if (!source.available) {
        return _jsx(MarketDataUnavailable, { title: "Spot prices", source: source });
    }
    if (prices.length === 0) {
        return _jsx(EmptyState, { icon: BarChart3, title: "No price snapshots yet" });
    }
    return (_jsx("div", { className: "grid grid-cols-[repeat(auto-fit,minmax(min(100%,13.5rem),1fr))] gap-3", children: prices.map((snapshot) => (_jsx(MajorPriceCard, { snapshot: snapshot }, snapshot.id))) }));
}
function MarketMoverList({ movers, source, }) {
    if (!source.available) {
        return _jsx(MarketDataUnavailable, { title: "Top movers", source: source });
    }
    if (movers.length === 0) {
        return _jsx(EmptyState, { icon: TrendingUp, title: "No market movers yet" });
    }
    return (_jsx("div", { className: "space-y-2", children: movers.map((mover) => {
            const isPositive = mover.change24hPct >= 0;
            return (_jsxs("div", { className: "flex min-w-0 items-center gap-3 rounded-2xl bg-bg/35 px-3 py-3", children: [_jsx(MarketAvatar, { imageUrl: mover.imageUrl, label: mover.symbol }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("div", { className: "flex min-w-0 items-center gap-2", children: [_jsx("span", { className: "truncate text-sm font-semibold text-txt", children: mover.symbol }), _jsx("span", { className: "truncate text-xs-tight text-muted", children: mover.name })] }), mover.marketCapRank !== null ? (_jsxs("div", { className: "mt-1 text-[0.68rem] font-medium uppercase tracking-[0.08em] text-muted", children: ["Cap rank #", mover.marketCapRank] })) : null] }), _jsxs("div", { className: "shrink-0 text-right", children: [_jsx("div", { className: "font-mono text-sm font-semibold text-txt", children: formatMarketUsd(mover.priceUsd) }), _jsx("div", { className: cn("text-xs font-semibold", isPositive ? "text-ok" : "text-danger"), children: formatPercentDelta(mover.change24hPct) })] })] }, mover.id));
        }) }));
}
function MarketPredictionList({ predictions, source, }) {
    if (!source.available) {
        return (_jsx(MarketDataUnavailable, { title: "Popular predictions", source: source }));
    }
    if (predictions.length === 0) {
        return _jsx(EmptyState, { icon: Sparkles, title: "No predictions yet" });
    }
    return (_jsx("div", { className: "space-y-2", children: predictions.map((prediction) => {
            const href = prediction.slug
                ? `https://polymarket.com/event/${prediction.slug}`
                : null;
            const endsAtLabel = formatMarketEndsAt(prediction.endsAt);
            const content = (_jsxs("div", { className: "flex min-w-0 items-center gap-3 rounded-2xl bg-bg/35 px-3 py-3 transition-colors hover:bg-bg/50", children: [_jsx(MarketAvatar, { imageUrl: prediction.imageUrl, label: prediction.highlightedOutcomeLabel }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "line-clamp-2 text-sm font-medium text-txt", children: prediction.question }), _jsxs("div", { className: "mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[0.68rem] font-medium uppercase tracking-[0.08em] text-muted", children: [_jsxs("span", { children: [prediction.highlightedOutcomeLabel, " ", formatProbability(prediction.highlightedOutcomeProbability)] }), _jsxs("span", { children: [formatCompactUsd(prediction.volume24hUsd), " 24h vol"] }), endsAtLabel ? _jsxs("span", { children: ["Ends ", endsAtLabel] }) : null] })] })] }, prediction.id));
            return href ? (_jsx("a", { href: href, target: "_blank", rel: "noreferrer", children: content }, prediction.id)) : (_jsx("div", { children: content }, prediction.id));
        }) }));
}
function MarketPulseHero({ overview, loading, error, }) {
    return (_jsxs("section", { className: "space-y-6", children: [_jsxs("div", { className: "max-w-2xl", children: [_jsx("h2", { className: "text-2xl font-semibold leading-tight text-txt md:text-[2rem]", children: "No balances or trade history yet." }), _jsx("p", { className: "mt-2 max-w-xl text-sm text-muted", children: overview?.stale
                            ? "Here's the latest cached market snapshot."
                            : "Here's what the market looks like right now." })] }), overview ? (_jsxs("div", { className: "mt-6 grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.92fr)]", children: [_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { children: [_jsx(MarketSectionHeader, { icon: BarChart3, title: "Spot prices", source: overview.sources.prices }), _jsx(MarketPriceGrid, { prices: overview.prices, source: overview.sources.prices })] }), _jsxs("div", { children: [_jsx(MarketSectionHeader, { icon: TrendingUp, title: "Top movers", source: overview.sources.movers }), _jsx(MarketMoverList, { movers: overview.movers, source: overview.sources.movers })] })] }), _jsxs("div", { children: [_jsx(MarketSectionHeader, { icon: Sparkles, title: "Popular predictions", source: overview.sources.predictions }), _jsx(MarketPredictionList, { predictions: overview.predictions, source: overview.sources.predictions })] })] })) : loading ? (_jsx("div", { className: "mt-6 grid grid-cols-[repeat(auto-fit,minmax(min(100%,13.5rem),1fr))] gap-3", children: ["btc", "eth", "sol"].map((placeholderId) => (_jsx("div", { className: "h-28 animate-pulse rounded-[26px] border border-border/30 bg-bg/35" }, placeholderId))) })) : error ? (_jsx("div", { className: "mt-6 rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger", children: error })) : null] }));
}
function activityEventMeta(eventType) {
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
function walletTimelineEntries({ profile, events, }) {
    const swapEntries = (profile?.recentSwaps ?? []).reduce((entries, swap) => {
        const timestamp = Date.parse(swap.createdAt);
        if (!Number.isFinite(timestamp))
            return entries;
        entries.push({
            id: `swap:${swap.hash}`,
            timestamp,
            title: `${swap.side === "buy" ? "Bought" : "Sold"} ${swap.tokenSymbol}`,
            detail: `${swap.inputAmount} ${swap.inputSymbol} -> ${swap.outputAmount} ${swap.outputSymbol}`,
            href: swap.explorerUrl,
            icon: ArrowLeftRight,
            tone: swap.status === "success"
                ? "ok"
                : swap.status === "pending"
                    ? "warn"
                    : "danger",
        });
        return entries;
    }, []);
    const agentEntries = events.map((event) => {
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
function PnlChart({ profile, }) {
    const points = profile?.pnlSeries ?? [];
    const values = points
        .map((point) => parseAmount(point.realizedPnlBnb))
        .filter((value) => value !== null);
    if (values.length < 2) {
        return (_jsx("div", { className: "flex h-40 items-center justify-center rounded-3xl bg-bg/30 text-xs text-muted", children: "No realized P&L yet" }));
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
    return (_jsx("svg", { className: "h-40 w-full rounded-3xl bg-bg/30", viewBox: "0 0 100 100", preserveAspectRatio: "none", "aria-label": "Trade P&L chart", children: _jsx("polyline", { fill: "none", stroke: stroke, strokeWidth: "3", strokeLinecap: "round", strokeLinejoin: "round", points: svgPoints, vectorEffect: "non-scaling-stroke" }) }));
}
function SummaryChip({ icon: Icon, value, tone = "default", title, }) {
    return (_jsxs("div", { className: cn("inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium", tone === "gain"
            ? "border-ok/30 bg-ok/10 text-ok"
            : tone === "loss"
                ? "border-danger/30 bg-danger/10 text-danger"
                : "border-border/35 bg-bg/35 text-txt"), title: title, children: [_jsx(Icon, { className: "h-3.5 w-3.5 shrink-0" }), _jsx("span", { children: value })] }));
}
function WalletRailAddress({ address, chains, emptyLabel, }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = useCallback(() => {
        if (!address)
            return;
        void navigator.clipboard.writeText(address).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
        });
    }, [address]);
    return (_jsxs("button", { type: "button", className: "flex w-full min-w-0 items-center justify-between gap-3 py-1 text-left transition-colors hover:text-txt", onClick: handleCopy, disabled: !address, title: address ?? emptyLabel, "aria-label": address ? `Copy ${emptyLabel} address` : `${emptyLabel} unavailable`, children: [_jsxs("span", { className: "flex min-w-0 items-center gap-3", children: [_jsx("span", { className: "flex shrink-0 -space-x-1.5", children: chains.map((chain) => (_jsx(ChainLogoBadge, { chain: chain, size: 18, className: "ring-1 ring-bg" }, chain))) }), _jsx("span", { className: cn("truncate font-mono text-xs", address ? "text-txt" : "text-muted"), children: address ?? emptyLabel })] }), address ? (copied ? (_jsx("span", { className: "shrink-0 text-[0.68rem] font-semibold text-ok", children: "Copied" })) : (_jsx(Copy, { className: "h-3.5 w-3.5 shrink-0 text-muted" }))) : null] }));
}
function WalletRailRpcButton({ walletConfig, onOpenSettings, }) {
    const evmReady = Boolean(walletConfig?.evmBalanceReady);
    const solanaReady = Boolean(walletConfig?.solanaBalanceReady);
    const toneClass = !walletConfig
        ? "bg-muted"
        : evmReady && solanaReady
            ? "bg-ok"
            : evmReady || solanaReady
                ? "bg-warn"
                : "bg-danger";
    const evmProvider = providerLabel(walletConfig?.selectedRpcProviders?.evm, "evm");
    const solanaProvider = providerLabel(walletConfig?.selectedRpcProviders?.solana, "solana");
    return (_jsxs("button", { type: "button", className: "inline-flex h-8 items-center gap-2 rounded-full border border-border/35 bg-bg/35 px-3 text-xs font-semibold text-txt transition-colors hover:bg-bg/55", onClick: onOpenSettings, title: `EVM: ${evmProvider} • Solana: ${solanaProvider}`, "aria-label": "Open RPC settings", children: [_jsx("span", { className: cn("h-2 w-2 rounded-full", toneClass) }), "RPC"] }));
}
function WalletRailAccount({ addresses, portfolioValueUsd, walletConfig, onOpenSettings, onRefresh, refreshing, }) {
    return (_jsxs("div", { className: "space-y-3", children: [_jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsx("div", { className: "font-mono text-xl font-semibold leading-none text-txt", children: formatUsd(portfolioValueUsd) }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(WalletRailRpcButton, { walletConfig: walletConfig, onOpenSettings: onOpenSettings }), _jsx(Button, { type: "button", variant: "ghost", size: "icon", className: "h-8 w-8 shrink-0 rounded-full border border-border/35 bg-bg/35 hover:bg-bg/55", onClick: onRefresh, disabled: refreshing, "aria-label": "Refresh wallet", title: "Refresh wallet", children: _jsx(RefreshCw, { className: cn("h-3.5 w-3.5", refreshing && "animate-spin") }) })] })] }), _jsx(WalletRailAddress, { address: addresses.evmAddress, chains: SUPPORTED_WALLET_CHAINS.filter((chain) => chain !== "solana"), emptyLabel: "No EVM address" }), _jsx(WalletRailAddress, { address: addresses.solanaAddress, chains: ["solana"], emptyLabel: "No Solana address" })] }));
}
function WalletRailActionButton({ icon: Icon, label, onClick, }) {
    return (_jsxs("button", { type: "button", className: "flex min-w-0 flex-col items-center justify-center gap-2 rounded-2xl border border-border/35 bg-bg/55 px-2 py-3 text-xs font-semibold text-txt transition-[transform,background-color,border-color,color,box-shadow] duration-150 hover:border-border/55 hover:bg-bg/80 hover:shadow-sm active:scale-[0.99]", onClick: onClick, "aria-label": label, title: label, children: [_jsx(Icon, { className: "h-4.5 w-4.5 text-accent" }), _jsx("span", { className: "truncate", children: label })] }));
}
function WalletRailEmpty({ icon: Icon, title, body, }) {
    return (_jsxs("div", { className: "flex min-h-[13rem] flex-col items-center justify-center px-5 text-center", children: [_jsx(Icon, { className: "mb-3 h-5 w-5 text-muted" }), _jsx("div", { className: "text-sm font-semibold text-txt", children: title }), body ? (_jsx("div", { className: "mt-1 text-xs-tight text-muted", children: body })) : null] }));
}
function TokenRailRow({ row, profile, maxPnl, onHideToken, onTokenAction, }) {
    return (_jsxs("div", { className: "group flex min-w-0 items-center gap-3 rounded-2xl px-2.5 py-2.5 transition-colors hover:bg-bg/55", children: [_jsx(TokenIdentityIcon, { row: row, size: 46 }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "truncate text-sm font-semibold text-txt", children: row.symbol }), _jsxs("div", { className: "truncate text-xs-tight text-muted", children: [formatBalance(row.balance), " ", row.symbol] }), _jsx("div", { className: "mt-1", children: _jsx(TokenPerformance, { row: row, profile: profile, maxAbsPnl: maxPnl }) })] }), _jsxs("div", { className: "flex shrink-0 flex-col items-end gap-2", children: [_jsx("div", { className: "font-mono text-sm font-semibold text-txt", children: formatUsd(row.valueUsd) }), _jsxs("div", { className: "flex gap-1 opacity-70 transition-opacity group-hover:opacity-100", children: [_jsx("button", { type: "button", className: "flex h-7 w-7 items-center justify-center rounded-full bg-bg/65 text-muted transition-colors hover:text-txt", onClick: () => onTokenAction(row, "swap"), "aria-label": `Swap ${row.symbol}`, title: `Swap ${row.symbol}`, children: _jsx(ArrowLeftRight, { className: "h-3.5 w-3.5" }) }), _jsx("button", { type: "button", className: "flex h-7 w-7 items-center justify-center rounded-full bg-bg/65 text-muted transition-colors hover:text-txt", onClick: () => onTokenAction(row, "bridge"), "aria-label": `Bridge ${row.symbol}`, title: `Bridge ${row.symbol}`, children: _jsx(Layers3, { className: "h-3.5 w-3.5" }) }), _jsx("button", { type: "button", className: "flex h-7 w-7 items-center justify-center rounded-full bg-bg/65 text-muted transition-colors hover:text-danger", onClick: () => onHideToken(row), "aria-label": `Hide ${row.symbol}`, title: `Hide ${row.symbol}`, children: _jsx(EyeOff, { className: "h-3.5 w-3.5" }) })] })] })] }));
}
function RailNftList({ nfts }) {
    if (nfts.length === 0) {
        return _jsx(WalletRailEmpty, { icon: ImageIcon, title: "No NFTs" });
    }
    return (_jsx("div", { className: "space-y-1", children: nfts.slice(0, 20).map((nft) => (_jsxs("div", { className: "flex min-w-0 items-center gap-3 rounded-2xl px-2.5 py-2.5 transition-colors hover:bg-bg/55", children: [nft.imageUrl ? (_jsx("img", { src: nft.imageUrl, alt: nft.name, className: "h-11 w-11 shrink-0 rounded-2xl object-cover", loading: "lazy" })) : (_jsx("div", { className: "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-bg/65", children: _jsx(ImageIcon, { className: "h-4 w-4 text-muted" }) })), _jsxs("div", { className: "min-w-0", children: [_jsx("div", { className: "truncate text-sm font-semibold text-txt", children: nft.name }), _jsx("div", { className: "truncate text-xs-tight text-muted", children: nft.collectionName })] })] }, `${nft.chain}:${nft.collectionName}:${nft.name}:${nft.imageUrl}`))) }));
}
function RailPositionList({ positions, }) {
    if (positions.length === 0) {
        return _jsx(WalletRailEmpty, { icon: Layers3, title: "No positions" });
    }
    return (_jsx("div", { className: "space-y-1", children: positions.map((position) => (_jsxs("div", { className: "flex min-w-0 items-center gap-3 rounded-2xl px-2.5 py-2.5 transition-colors hover:bg-bg/55", children: [position.imageUrl ? (_jsx("img", { src: position.imageUrl, alt: position.label, className: "h-11 w-11 shrink-0 rounded-2xl object-cover", loading: "lazy" })) : (_jsx("div", { className: "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-bg/65", children: _jsx(Layers3, { className: "h-4 w-4 text-muted" }) })), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "truncate text-sm font-semibold text-txt", children: position.label }), _jsx("div", { className: "truncate text-xs-tight text-muted", children: position.detail })] }), position.valueUsd !== null && position.valueUsd > 0 ? (_jsx("div", { className: "shrink-0 font-mono text-sm font-semibold text-txt", children: formatUsd(position.valueUsd) })) : null] }, position.id))) }));
}
function TokenRail({ rows, nfts, positions, addresses, hiddenTokenIds, walletConfig, profile, onHideToken, onTokenAction, onWalletAction, onOpenRpcSettings, onRefresh, refreshing, walletEnabled, onEnableWallet, }) {
    const [activeTab, setActiveTab] = useState("tokens");
    const [sidebarCollapsed, setSidebarCollapsed] = useState(loadInitialWalletSidebarCollapsed);
    const [sidebarWidth, setSidebarWidth] = useState(loadInitialWalletSidebarWidth);
    const isDesktopSidebar = useWalletSidebarDesktopMode();
    const showIconOnlyTabs = isDesktopSidebar && !sidebarCollapsed && sidebarWidth <= 304;
    const visibleRows = useMemo(() => rows.filter((row) => {
        if (hiddenTokenIds.has(tokenId(row)))
            return false;
        return tokenHasInventory(row);
    }), [hiddenTokenIds, rows]);
    const totalUsd = useMemo(() => visibleRows.reduce((sum, row) => sum + row.valueUsd, 0), [visibleRows]);
    const maxPnl = useMemo(() => maxAbsTokenPnl(visibleRows, profile), [visibleRows, profile]);
    const tabs = [
        {
            id: "tokens",
            label: "Tokens",
            icon: Wallet,
        },
        { id: "defi", label: "DeFi", icon: Layers3 },
        { id: "nfts", label: "NFTs", icon: ImageIcon },
    ];
    const handleSidebarCollapsedChange = useCallback((next) => {
        setSidebarCollapsed(next);
        try {
            window.localStorage.setItem(WALLET_SIDEBAR_COLLAPSED_KEY, String(next));
        }
        catch {
            /* ignore sandboxed storage */
        }
    }, []);
    const handleSidebarWidthChange = useCallback((next) => {
        const clamped = clampWalletSidebarWidth(next);
        setSidebarWidth(clamped);
        try {
            window.localStorage.setItem(WALLET_SIDEBAR_WIDTH_KEY, String(clamped));
        }
        catch {
            /* ignore sandboxed storage */
        }
    }, []);
    const headerContent = (_jsxs("div", { className: "space-y-4", children: [visibleRows.length > 0 ? (_jsx(AssetAllocationStrip, { rows: visibleRows, compact: true })) : null, walletEnabled === false ? (_jsx(Button, { className: "w-full rounded-2xl", onClick: onEnableWallet, children: "Enable wallet" })) : null, _jsxs("div", { className: "grid grid-cols-3 gap-2", children: [_jsx(WalletRailActionButton, { icon: ArrowLeftRight, label: "Swap", onClick: () => onWalletAction("swap") }), _jsx(WalletRailActionButton, { icon: Send, label: "Send", onClick: () => onWalletAction("send") }), _jsx(WalletRailActionButton, { icon: ArrowDownLeft, label: "Receive", onClick: () => onWalletAction("receive") })] }), _jsx("div", { className: "grid min-w-0 grid-cols-3 rounded-2xl bg-bg/45 p-1", children: tabs.map((tab) => (_jsxs("button", { type: "button", className: cn("inline-flex min-w-0 items-center justify-center gap-1.5 rounded-[calc(var(--radius-lg)_-_4px)] px-3 py-2 text-sm font-semibold transition-colors", showIconOnlyTabs ? "px-2" : undefined, activeTab === tab.id
                        ? "bg-bg text-txt shadow-sm"
                        : "text-muted hover:text-txt"), onClick: () => setActiveTab(tab.id), "aria-label": tab.label, title: tab.label, children: [_jsx(tab.icon, { className: "h-3.5 w-3.5 shrink-0" }), !showIconOnlyTabs ? (_jsx("span", { className: "truncate", children: tab.label })) : null] }, tab.id))) })] }));
    return (_jsxs(AppPageSidebar, { testId: "wallets-sidebar", collapsible: true, collapsed: sidebarCollapsed, onCollapsedChange: handleSidebarCollapsedChange, resizable: true, width: sidebarWidth, onWidthChange: handleSidebarWidthChange, minWidth: WALLET_SIDEBAR_MIN_WIDTH, maxWidth: WALLET_SIDEBAR_MAX_WIDTH, onCollapseRequest: () => handleSidebarCollapsedChange(true), contentIdentity: `wallets:${activeTab}`, collapseButtonTestId: "wallets-sidebar-collapse-toggle", collapseButtonAriaLabel: "Collapse wallet", expandButtonTestId: "wallets-sidebar-expand-toggle", expandButtonAriaLabel: "Expand wallet", collapsedRailItems: tabs.map((tab) => (_jsx(SidebarContent.RailItem, { "aria-label": tab.label, title: tab.label, active: activeTab === tab.id, onClick: () => setActiveTab(tab.id), children: _jsx(tab.icon, { className: "h-4 w-4" }) }, tab.id))), mobileTitle: "Wallet", mobileMeta: null, children: [_jsxs("div", { className: "shrink-0 px-4 pb-3 pt-0", children: [_jsx(WalletRailAccount, { addresses: addresses, portfolioValueUsd: totalUsd, walletConfig: walletConfig, onOpenSettings: onOpenRpcSettings, onRefresh: onRefresh, refreshing: refreshing }), _jsx("div", { className: "mt-4", children: headerContent })] }), _jsx(SidebarScrollRegion, { className: "pt-0", children: _jsx(SidebarPanel, { className: "space-y-1", children: activeTab === "tokens" ? (visibleRows.length === 0 ? (_jsx(WalletRailEmpty, { icon: Wallet, title: "No assets" })) : (visibleRows.map((row) => (_jsx(TokenRailRow, { row: row, profile: profile, maxPnl: maxPnl, onHideToken: onHideToken, onTokenAction: onTokenAction }, tokenId(row)))))) : activeTab === "defi" ? (_jsx(RailPositionList, { positions: positions })) : activeTab === "nfts" ? (_jsx(RailNftList, { nfts: nfts })) : null }) })] }));
}
function DashboardSection({ title, icon: Icon, action, children, }) {
    return (_jsxs("section", { className: "rounded-[28px] border border-border/30 bg-bg/45 px-5 py-5 md:px-6", children: [_jsxs("div", { className: "mb-4 flex flex-wrap items-center justify-between gap-3", children: [_jsxs("div", { className: "flex items-center gap-2 text-sm font-semibold text-txt", children: [_jsx(Icon, { className: "h-4 w-4 text-accent" }), title] }), action] }), children] }));
}
function ActivityLog({ profile, events, }) {
    const entries = useMemo(() => walletTimelineEntries({ profile, events }), [events, profile]);
    if (entries.length === 0) {
        return _jsx(EmptyState, { icon: Activity, title: "No activity yet" });
    }
    return (_jsx("div", { className: "space-y-2", children: entries.map((entry) => {
            const toneClass = entry.tone === "ok"
                ? "bg-ok/10 text-ok"
                : entry.tone === "warn"
                    ? "bg-warn/10 text-warn"
                    : entry.tone === "danger"
                        ? "bg-danger/10 text-danger"
                        : "bg-bg/55 text-muted";
            const body = (_jsxs("div", { className: "flex min-w-0 items-center gap-3 rounded-2xl bg-bg/35 px-3 py-2.5 text-sm transition-colors hover:bg-bg/55", children: [_jsx("span", { className: cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full", toneClass), children: _jsx(entry.icon, { className: "h-4 w-4" }) }), _jsxs("span", { className: "min-w-0 flex-1", children: [_jsx("span", { className: "block truncate font-medium text-txt", children: entry.title }), entry.detail ? (_jsx("span", { className: "block truncate text-xs-tight text-muted", children: entry.detail })) : null] }), _jsx("span", { className: "shrink-0 text-[0.68rem] font-medium text-muted", children: formatRelativeTimestamp(entry.timestamp) })] }));
            if (entry.href) {
                return (_jsx("a", { href: entry.href, target: "_blank", rel: "noreferrer", children: body }, entry.id));
            }
            return _jsx("div", { children: body }, entry.id);
        }) }));
}
function NftPreview({ nfts }) {
    const visible = nfts.slice(0, 6);
    if (visible.length === 0) {
        return _jsx(EmptyState, { icon: ImageIcon, title: "No NFTs" });
    }
    return (_jsx("div", { className: "grid grid-cols-2 gap-3 md:grid-cols-3", children: visible.map((nft) => (_jsxs("div", { className: "overflow-hidden rounded-2xl bg-bg/35", children: [nft.imageUrl ? (_jsx("img", { src: nft.imageUrl, alt: nft.name, className: "aspect-square w-full object-cover", loading: "lazy" })) : (_jsx("div", { className: "flex aspect-square items-center justify-center bg-bg/50", children: _jsx(ImageIcon, { className: "h-5 w-5 text-muted" }) })), _jsxs("div", { className: "min-w-0 p-2", children: [_jsx("div", { className: "truncate text-xs font-medium text-txt", children: nft.name }), _jsx("div", { className: "truncate text-[0.68rem] text-muted", children: nft.collectionName })] })] }, `${nft.chain}:${nft.collectionName}:${nft.name}:${nft.imageUrl}`))) }));
}
function LpPositionsPanel({ positions, }) {
    if (positions.length === 0) {
        return _jsx(EmptyState, { icon: Layers3, title: "No positions" });
    }
    return (_jsx("div", { className: "grid gap-2", children: positions.map((position) => (_jsxs("div", { className: "flex min-w-0 items-center gap-3 rounded-2xl bg-bg/35 p-3", children: [position.imageUrl ? (_jsx("img", { src: position.imageUrl, alt: position.label, className: "h-10 w-10 shrink-0 rounded-2xl object-cover", loading: "lazy" })) : (_jsx("div", { className: "flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-bg/50", children: position.kind === "nft" ? (_jsx(ImageIcon, { className: "h-4 w-4 text-muted" })) : (_jsx(Layers3, { className: "h-4 w-4 text-muted" })) })), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "truncate text-sm font-semibold text-txt", children: position.label }), _jsx("div", { className: "truncate text-xs-tight text-muted", children: position.detail })] }), position.valueUsd !== null && position.valueUsd > 0 ? (_jsx("div", { className: "shrink-0 font-mono text-sm font-semibold text-txt", children: formatUsd(position.valueUsd) })) : null] }, position.id))) }));
}
export function InventoryView() {
    const { walletEnabled, walletAddresses, walletConfig, walletBalances, walletNfts, walletLoading, walletNftsLoading, walletError, loadWalletConfig, loadBalances, loadNfts, setState, setTab, setActionNotice, } = useApp();
    const { events: activityEvents } = useActivityEvents();
    const [hiddenTokenIds, setHiddenTokenIds] = useState(() => readHiddenTokenIds());
    const [dashboardWindow, setDashboardWindow] = useState("30d");
    const [tradingProfile, setTradingProfile] = useState(null);
    const [tradingProfileLoading, setTradingProfileLoading] = useState(false);
    const [tradingProfileError, setTradingProfileError] = useState(null);
    const [marketOverview, setMarketOverview] = useState(null);
    const [marketOverviewLoading, setMarketOverviewLoading] = useState(false);
    const [marketOverviewError, setMarketOverviewError] = useState(null);
    const initialLoadRef = useRef(false);
    const tradingProfileRequestRef = useRef(0);
    const marketOverviewRequestRef = useRef(0);
    const loadTradingProfile = useCallback(async () => {
        const requestId = tradingProfileRequestRef.current + 1;
        tradingProfileRequestRef.current = requestId;
        setTradingProfileLoading(true);
        setTradingProfileError(null);
        try {
            const profile = await client.getWalletTradingProfile(tradingProfileWindow(dashboardWindow));
            if (tradingProfileRequestRef.current === requestId) {
                setTradingProfile(profile);
            }
        }
        catch (cause) {
            const message = cause instanceof Error && cause.message.trim().length > 0
                ? cause.message.trim()
                : "Failed to load trading profile.";
            if (tradingProfileRequestRef.current === requestId) {
                setTradingProfile(null);
                setTradingProfileError(message);
            }
        }
        finally {
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
        }
        catch (cause) {
            const message = cause instanceof Error && cause.message.trim().length > 0
                ? cause.message.trim()
                : "Failed to load market overview.";
            if (marketOverviewRequestRef.current === requestId) {
                setMarketOverviewError(message);
            }
        }
        finally {
            if (marketOverviewRequestRef.current === requestId) {
                setMarketOverviewLoading(false);
            }
        }
    }, []);
    useEffect(() => {
        if (initialLoadRef.current)
            return;
        initialLoadRef.current = true;
        void loadWalletConfig();
        void loadMarketOverview();
        if (walletEnabled === false)
            return;
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
    const visibleAssetRows = useMemo(() => inventoryData.tokenRowsAllChains.filter(tokenHasInventory), [inventoryData.tokenRowsAllChains]);
    const displayedAssetRows = useMemo(() => visibleAssetRows.filter((row) => !hiddenTokenIds.has(tokenId(row))), [hiddenTokenIds, visibleAssetRows]);
    const lpPositions = useMemo(() => deriveInventoryPositionAssets({
        tokenRows: displayedAssetRows,
        nfts: inventoryData.allNfts,
    }), [displayedAssetRows, inventoryData.allNfts]);
    const pnlValue = parseAmount(tradingProfile?.summary.realizedPnlBnb);
    const showTradePnl = hasClosedTradePnl(tradingProfile);
    const hasWalletTimeline = activityEvents.length > 0 || (tradingProfile?.recentSwaps.length ?? 0) > 0;
    const showMarketPulseHero = walletEnabled === false ||
        (!walletLoading &&
            !walletNftsLoading &&
            !tradingProfileLoading &&
            displayedAssetRows.length === 0 &&
            lpPositions.length === 0 &&
            inventoryData.allNfts.length === 0 &&
            !showTradePnl &&
            !hasWalletTimeline);
    const handleHideToken = useCallback((row) => {
        const next = new Set(hiddenTokenIds);
        next.add(tokenId(row));
        setHiddenTokenIds(next);
        writeHiddenTokenIds(next);
        setActionNotice(`${row.symbol} hidden from this wallet view.`);
    }, [hiddenTokenIds, setActionNotice]);
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
    const handleTokenAction = useCallback((row, action) => {
        const verb = action === "swap" ? "swap" : "bridge";
        dispatchWalletChatPrefill(`Prepare a ${verb} for ${row.symbol}. Use the visible wallet inventory, then ask me for amount, destination, slippage, and execution path before any transaction.`);
        setActionNotice(`Prepared a ${verb} request for ${row.symbol} in wallet chat.`);
    }, [setActionNotice]);
    const handleWalletAction = useCallback((action) => {
        const prompt = action === "swap"
            ? "Prepare a wallet swap. Ask me for source token, destination token, amount, slippage, and route before any transaction."
            : action === "send"
                ? "Prepare a transfer. Ask me for token, amount, recipient address, and network requirements before any transaction."
                : "Show the EVM and Solana receive addresses available in this wallet and ask which address I want to use.";
        dispatchWalletChatPrefill(prompt);
        setActionNotice(`Prepared ${action} in wallet chat.`);
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
        void loadNfts();
    }, [loadBalances, loadNfts, loadWalletConfig, setState]);
    const tokenSidebar = (_jsx(TokenRail, { rows: visibleAssetRows, nfts: inventoryData.allNfts, positions: lpPositions, addresses: addresses, hiddenTokenIds: hiddenTokenIds, walletConfig: walletConfig, profile: tradingProfile, onHideToken: handleHideToken, onTokenAction: handleTokenAction, onWalletAction: handleWalletAction, onOpenRpcSettings: handleOpenRpcSettings, onRefresh: handleRefresh, refreshing: walletLoading ||
            walletNftsLoading ||
            tradingProfileLoading ||
            marketOverviewLoading, walletEnabled: walletEnabled, onEnableWallet: handleEnableWallet }));
    return (_jsx(PageLayout, { className: "h-full", "data-testid": "wallet-shell", sidebar: tokenSidebar, contentClassName: "bg-bg", contentInnerClassName: "w-full min-h-0", mobileSidebarLabel: "Wallet", children: _jsxs("div", { className: "mx-auto flex w-full max-w-5xl flex-col gap-7 px-5 py-6 sm:px-7 lg:px-9", children: [walletError ? (_jsx("div", { className: "rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger", children: walletError })) : null, showMarketPulseHero ? (_jsx(MarketPulseHero, { overview: marketOverview, loading: marketOverviewLoading, error: marketOverviewError })) : null, !showMarketPulseHero ? (_jsxs("div", { className: "grid gap-8 xl:grid-cols-[minmax(0,1.22fr)_minmax(20rem,0.8fr)]", children: [_jsxs("div", { className: "space-y-8", children: [_jsxs(DashboardSection, { title: "P&L", icon: BarChart3, action: _jsx("div", { className: "flex rounded-full bg-bg/40 p-1", children: DASHBOARD_WINDOWS.map((window) => (_jsx("button", { type: "button", className: cn("rounded-full px-3 py-1.5 text-xs font-medium transition-colors", dashboardWindow === window
                                                ? "bg-accent text-[color:var(--accent-foreground)]"
                                                : "text-muted hover:text-txt"), onClick: () => setDashboardWindow(window), children: window }, window))) }), children: [(showTradePnl && pnlValue !== null) ||
                                            displayedAssetRows.length > 0 ? (_jsxs("div", { className: "mb-4 flex flex-wrap items-center gap-3", children: [showTradePnl && pnlValue !== null ? (_jsx(SummaryChip, { icon: pnlValue >= 0 ? TrendingUp : TrendingDown, value: `${pnlValue > 0 ? "+" : ""}${formatBnb(tradingProfile?.summary.realizedPnlBnb)}`, tone: pnlValue >= 0 ? "gain" : "loss", title: "Realized P&L" })) : null, displayedAssetRows.length > 0 ? (_jsx("div", { className: "min-w-0 flex-1", children: _jsx(AssetAllocationStrip, { rows: displayedAssetRows, compact: true }) })) : null] })) : null, _jsx(PnlChart, { profile: tradingProfile }), tradingProfileError ? (_jsx("div", { className: "mt-3 text-xs-tight text-danger", children: tradingProfileError })) : null] }), _jsx(DashboardSection, { title: "Activity", icon: Activity, children: _jsx(ActivityLog, { profile: tradingProfile, events: activityEvents }) })] }), _jsxs("div", { className: "space-y-8", children: [_jsx(DashboardSection, { title: "Movers", icon: TrendingUp, children: _jsx(PortfolioMoversPanel, { rows: displayedAssetRows, profile: tradingProfile, marketOverview: marketOverview }) }), _jsx(DashboardSection, { title: "LP positions", icon: Layers3, children: _jsx(LpPositionsPanel, { positions: lpPositions }) }), _jsx(DashboardSection, { title: "NFTs", icon: ImageIcon, children: _jsx(NftPreview, { nfts: inventoryData.allNfts }) })] })] })) : null] }) }));
}
