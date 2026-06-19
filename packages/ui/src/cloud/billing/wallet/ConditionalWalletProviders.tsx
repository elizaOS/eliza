/**
 * Lazy boundary for the wallet stack (wagmi + RainbowKit + Solana + viem).
 *
 * Ported from `@elizaos/cloud-frontend/src/providers/ConditionalWalletProviders.tsx`.
 * On non-wallet routes it renders `children` directly so the heavy wallet vendor
 * chunks never enter the entry bundle; on wallet routes it lazy-loads the real
 * provider tree ({@link StewardWalletProviders}) behind Suspense as the outermost
 * wrapper so downstream wallet hooks resolve their contexts.
 *
 * Billing crypto direct-payments and the success route are the wallet surfaces in
 * this domain. Keep {@link WALLET_ROUTE_PATTERNS} in sync with any new route that
 * calls wallet hooks or renders `<DirectCryptoCreditCard>`.
 */

import { Component, lazy, type ReactNode, Suspense, useMemo } from "react";
import { matchPath, useLocation } from "react-router-dom";
import { useCloudT } from "../../shell/CloudI18nProvider";

const WALLET_ROUTE_PATTERNS = [
  "/dashboard/billing",
  "/dashboard/billing/*",
  "/settings",
  "/settings/*",
];

const LazyStewardWalletProviders = lazy(async () => {
  const mod = await import("./steward-wallet-providers");
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
  return WALLET_ROUTE_PATTERNS.some((pattern) =>
    matchPath({ path: pattern, end: !pattern.endsWith("*") }, pathname),
  );
}

export function ConditionalWalletProviders({
  children,
}: {
  children: ReactNode;
}) {
  const t = useCloudT();
  const { pathname } = useLocation();
  const needsWallet = useMemo(() => isWalletRoute(pathname), [pathname]);

  if (!needsWallet) {
    return <>{children}</>;
  }

  return (
    <ChunkLoadErrorBoundary
      fallback={
        <div className="flex min-h-screen items-center justify-center p-6 text-center text-sm text-muted-foreground">
          <div>
            <p>
              {t("cloud.wallet.loadFailed", {
                defaultValue: "Failed to load the wallet module.",
              })}
            </p>
            <p className="mt-2">
              <button
                className="underline"
                onClick={() => {
                  if (typeof window !== "undefined") {
                    window.sessionStorage.removeItem(CHUNK_RELOAD_FLAG);
                    window.location.reload();
                  }
                }}
                type="button"
              >
                {t("cloud.wallet.reloadPage", { defaultValue: "Reload page" })}
              </button>
            </p>
          </div>
        </div>
      }
    >
      <Suspense fallback={<div aria-busy="true" className="min-h-screen" />}>
        <LazyStewardWalletProviders>{children}</LazyStewardWalletProviders>
      </Suspense>
    </ChunkLoadErrorBoundary>
  );
}
