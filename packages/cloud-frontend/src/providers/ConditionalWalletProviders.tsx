import { lazy, type ReactNode, Suspense, useMemo } from "react";
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

function isWalletRoute(pathname: string): boolean {
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
