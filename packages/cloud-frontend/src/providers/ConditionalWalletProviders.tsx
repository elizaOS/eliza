import { Component, lazy, type ReactNode, Suspense, useMemo } from "react";
import { matchPath, useLocation } from "react-router-dom";

/**
 * Lazy boundary for the wallet stack (wagmi + RainbowKit + Solana wallet
 * adapters + viem). On non-wallet routes we render `children` directly so the
 * heavy wallet vendor chunks never enter the entry bundle. On wallet routes
 * we lazy-load the real provider tree behind Suspense, mounting it as the
 * outermost wrapper so downstream wallet hooks resolve their contexts.
 *
 * Keep this list in sync with any new route that calls wallet hooks
 * (`useAccount`, `useWallet`, `useConnectModal`, etc.) or renders a wallet UI
 * component such as `<DirectCryptoCreditCard>`. Routes that merely link to a
 * wallet flow do not need to appear here.
 */
const WALLET_ROUTE_PATTERNS = [
  "/login",
  "/login/*",
  "/bsc",
  "/bsc/*",
  "/dashboard/billing",
  "/dashboard/billing/*",
  "/dashboard/settings",
  "/dashboard/settings/*",
  "/dashboard/affiliates",
  "/dashboard/affiliates/*",
  "/checkout",
  "/checkout/*",
  "/payment/:paymentRequestId",
];

const LazyStewardWalletProviders = lazy(async () => {
  const mod = await import("@/pages/login/steward-wallet-providers");
  return { default: mod.StewardWalletProviders };
});

const CHUNK_RELOAD_FLAG = "eliza:chunk-reload-attempted";

function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message ?? "";
  return (
    error.name === "ChunkLoadError" ||
    message.includes("Failed to fetch dynamically imported module") ||
    message.includes("Importing a module script failed") ||
    message.includes("error loading dynamically imported module") ||
    /Expected a JavaScript-or-Wasm module script/.test(message)
  );
}

class ChunkLoadErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(error: unknown) {
    if (isChunkLoadError(error)) {
      if (typeof window !== "undefined") {
        const alreadyTried =
          window.sessionStorage.getItem(CHUNK_RELOAD_FLAG) === "1";
        if (!alreadyTried) {
          window.sessionStorage.setItem(CHUNK_RELOAD_FLAG, "1");
          window.location.reload();
          return { failed: true };
        }
      }
      return { failed: true };
    }
    throw error;
  }

  render() {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

function isWalletRoute(pathname: string): boolean {
  if (pathname === "/payment/success") {
    return false;
  }
  return WALLET_ROUTE_PATTERNS.some((pattern) =>
    matchPath({ path: pattern, end: !pattern.endsWith("*") }, pathname),
  );
}

export function ConditionalWalletProviders({
  children,
}: {
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  const needsWallet = useMemo(() => isWalletRoute(pathname), [pathname]);

  if (!needsWallet) {
    return <>{children}</>;
  }

  return (
    <Suspense fallback={<div aria-busy="true" className="min-h-screen" />}>
      <LazyStewardWalletProviders>{children}</LazyStewardWalletProviders>
    </Suspense>
  );
}
