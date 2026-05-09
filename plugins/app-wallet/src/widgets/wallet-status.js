import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Check, Copy, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "@elizaos/ui";
import { EmptyWidgetState, WidgetSection, } from "@elizaos/ui";
import { getNativeLogoUrl, resolveChainKey, } from "../inventory/chainConfig";
import { normalizeInventoryImageUrl } from "../inventory/media-url";
const DUST_THRESHOLD_USD = 0.01;
const COPY_FEEDBACK_MS = 1200;
const EVM_CHAIN_ORDER = [
    "ethereum",
    "base",
    "arbitrum",
    "optimism",
    "polygon",
    "bsc",
    "avax",
];
const EVM_CHAIN_KEYS = new Set(EVM_CHAIN_ORDER);
const CHAIN_DISPLAY_LABELS = {
    ethereum: "Ethereum",
    base: "Base",
    arbitrum: "Arbitrum",
    optimism: "Optimism",
    polygon: "Polygon",
    bsc: "BNB Chain",
    avax: "Avalanche",
    solana: "Solana",
};
function shortenAddress(value) {
    if (!value)
        return null;
    if (value.length <= 10)
        return value;
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
function parseUsd(value) {
    if (typeof value !== "string")
        return 0;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
function formatUsd(value) {
    if (value >= 1000) {
        return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    }
    if (value >= 1) {
        return `$${value.toFixed(2)}`;
    }
    return `$${value.toFixed(2)}`;
}
function hasPositiveBalance(value) {
    if (!value)
        return false;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0;
}
function normalizeEvmChainKeys(chainNames) {
    const seen = new Set();
    for (const chainName of chainNames) {
        const chainKey = resolveChainKey(chainName);
        if (chainKey && EVM_CHAIN_KEYS.has(chainKey)) {
            seen.add(chainKey);
        }
    }
    return EVM_CHAIN_ORDER.filter((chainKey) => seen.has(chainKey));
}
function ChainBadge({ chain }) {
    // Use the same per-chain logo URLs the wallet page uses — these are real
    // raster logos pulled from the trustwallet/assets repo (see
    // CHAIN_CONFIGS[*].nativeLogoUrl) and cover every chain we register,
    // including Arbitrum / Optimism / Polygon that the SVG-only ChainIcon
    // doesn't have paths for.
    const [errored, setErrored] = useState(false);
    const label = CHAIN_DISPLAY_LABELS[chain];
    const url = errored
        ? null
        : (normalizeInventoryImageUrl(getNativeLogoUrl(chain)) ?? null);
    if (url) {
        return (_jsx("img", { src: url, alt: label, title: label, width: 16, height: 16, className: "inline-flex h-4 w-4 shrink-0 rounded-full bg-bg/40 object-cover", onError: () => setErrored(true) }));
    }
    // Tiny initials fallback when the logo URL fails or is missing.
    return (_jsx("span", { className: "inline-flex h-4 shrink-0 items-center rounded-full border border-border/35 bg-bg/40 px-1.5 font-mono text-[0.52rem] font-semibold leading-none text-muted", title: label, role: "img", "aria-label": label, children: label.slice(0, 3).toUpperCase() }));
}
function ChainBadges({ chains }) {
    return (_jsx("span", { className: "flex min-w-0 flex-wrap items-center gap-1", children: chains.map((chain) => (_jsx(ChainBadge, { chain: chain }, chain))) }));
}
function CopyAddressButton({ value, label }) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied)
            return;
        const timer = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
        return () => clearTimeout(timer);
    }, [copied]);
    async function onClick(event) {
        event.preventDefault();
        event.stopPropagation();
        try {
            if (typeof navigator === "undefined" || !navigator.clipboard) {
                return;
            }
            await navigator.clipboard.writeText(value);
            setCopied(true);
        }
        catch {
            return;
        }
    }
    return (_jsx("button", { type: "button", onClick: onClick, "aria-label": copied ? `${label} copied` : `Copy ${label}`, title: copied ? "Copied" : "Copy", className: "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt", children: copied ? (_jsx(Check, { className: "h-3 w-3", "aria-hidden": true })) : (_jsx(Copy, { className: "h-3 w-3", "aria-hidden": true })) }));
}
export function WalletStatusSidebarWidget(_props) {
    const { walletEnabled, walletAddresses, walletConfig, walletBalances, loadWalletConfig, loadBalances, setTab, } = useApp();
    useEffect(() => {
        if (walletEnabled === false)
            return;
        if (walletConfig === null) {
            void loadWalletConfig();
        }
        if (walletBalances !== null)
            return;
        void loadBalances();
    }, [
        walletEnabled,
        walletConfig,
        walletBalances,
        loadWalletConfig,
        loadBalances,
    ]);
    const evmAddress = walletAddresses?.evmAddress ?? null;
    const solanaAddress = walletAddresses?.solanaAddress ?? null;
    const evmShort = shortenAddress(evmAddress);
    const solanaShort = shortenAddress(solanaAddress);
    const evmChains = normalizeEvmChainKeys([
        ...(walletConfig?.evmChains ?? []),
        ...(walletBalances?.evm?.chains.map((chain) => chain.chain) ?? []),
    ]);
    const walletSummary = useMemo(() => {
        let assetCount = 0;
        let totalUsd = 0;
        if (walletBalances?.evm) {
            for (const chain of walletBalances.evm.chains) {
                const nativeUsd = parseUsd(chain.nativeValueUsd);
                totalUsd += nativeUsd;
                if (nativeUsd >= DUST_THRESHOLD_USD ||
                    hasPositiveBalance(chain.nativeBalance)) {
                    assetCount += 1;
                }
                for (const token of chain.tokens) {
                    const tokenUsd = parseUsd(token.valueUsd);
                    totalUsd += tokenUsd;
                    if (tokenUsd >= DUST_THRESHOLD_USD ||
                        hasPositiveBalance(token.balance)) {
                        assetCount += 1;
                    }
                }
            }
        }
        if (walletBalances?.solana) {
            const nativeUsd = parseUsd(walletBalances.solana.solValueUsd);
            totalUsd += nativeUsd;
            if (nativeUsd >= DUST_THRESHOLD_USD ||
                hasPositiveBalance(walletBalances.solana.solBalance)) {
                assetCount += 1;
            }
            for (const token of walletBalances.solana.tokens) {
                const tokenUsd = parseUsd(token.valueUsd);
                totalUsd += tokenUsd;
                if (tokenUsd >= DUST_THRESHOLD_USD ||
                    hasPositiveBalance(token.balance)) {
                    assetCount += 1;
                }
            }
        }
        return { assetCount, totalUsd };
    }, [walletBalances]);
    if (walletEnabled === false) {
        return null;
    }
    const hasAnyAddress = Boolean(evmAddress || solanaAddress);
    const hasAnyBalanceRow = walletSummary.assetCount > 0;
    return (_jsx(WidgetSection, { title: "Wallet", icon: _jsx(Wallet, { className: "h-3.5 w-3.5" }), testId: "chat-widget-wallet-status", onTitleClick: () => setTab("inventory"), children: hasAnyAddress ? (_jsxs("div", { className: "flex flex-col gap-1.5 px-1 pt-0.5", children: [evmAddress ? (_jsxs("div", { className: "flex items-center justify-between gap-2 text-3xs", "data-testid": "chat-widget-wallet-row-evm-address", children: [_jsx(ChainBadges, { chains: evmChains }), _jsxs("div", { className: "flex items-center gap-1 min-w-0", children: [_jsx("span", { className: "truncate font-mono text-txt", title: evmAddress, children: evmShort }), _jsx(CopyAddressButton, { value: evmAddress, label: "EVM address" })] })] })) : null, solanaAddress ? (_jsxs("div", { className: "flex items-center justify-between gap-2 text-3xs", "data-testid": "chat-widget-wallet-row-solana-address", children: [_jsx(ChainBadge, { chain: "solana" }), _jsxs("div", { className: "flex items-center gap-1 min-w-0", children: [_jsx("span", { className: "truncate font-mono text-txt", title: solanaAddress, children: solanaShort }), _jsx(CopyAddressButton, { value: solanaAddress, label: "Solana address" })] })] })) : null, hasAnyBalanceRow ? (_jsxs("div", { className: "mt-1 flex flex-col gap-1 border-t border-border/20 pt-1.5", children: [_jsxs("div", { className: "flex items-center justify-between text-3xs", "data-testid": "chat-widget-wallet-row-assets", children: [_jsx("span", { className: "truncate text-muted", children: "Assets" }), _jsx("span", { className: "shrink-0 text-txt", children: walletSummary.assetCount })] }), _jsxs("div", { className: "flex items-center justify-between text-3xs", "data-testid": "chat-widget-wallet-row-value", children: [_jsx("span", { className: "truncate text-muted", children: "Value" }), _jsx("span", { className: "shrink-0 text-txt", children: formatUsd(walletSummary.totalUsd) })] })] })) : null] })) : (_jsx(EmptyWidgetState, { icon: _jsx(Wallet, { className: "h-5 w-5" }), title: "No wallet addresses yet" })) }));
}
export const WALLET_STATUS_WIDGET = {
    id: "wallet.status",
    pluginId: "wallet",
    order: 70,
    defaultEnabled: true,
    Component: WalletStatusSidebarWidget,
};
