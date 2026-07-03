/**
 * WalletSectionNav — the sub-navigation shared by the Wallet family of routes.
 *
 * Hyperliquid (perps) and Polymarket (predictions) are sub-views of Wallet
 * rather than standalone launcher apps, so the three routes render one another
 * under a common tab strip. Mounted in the workspace chrome `nav` slot for
 * `/wallet`, `/inventory`, `/hyperliquid`, and `/polymarket` (see App.tsx).
 */

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

interface WalletSectionTab {
  id: string;
  label: string;
  path: string;
  /** Extra paths that should also mark this tab active. */
  aliases?: string[];
}

export const WALLET_SECTION_TABS: readonly WalletSectionTab[] = [
  { id: "wallet", label: "Wallet", path: "/wallet", aliases: ["/inventory"] },
  { id: "hyperliquid", label: "Perps", path: "/hyperliquid" },
  { id: "polymarket", label: "Predictions", path: "/polymarket" },
];

function normalizePath(path: string): string {
  const trimmed = (path || "/").split(/[?#]/, 1)[0].toLowerCase();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 && withSlash.endsWith("/")
    ? withSlash.slice(0, -1)
    : withSlash;
}

const WALLET_SECTION_PATHS = new Set(
  WALLET_SECTION_TABS.flatMap((tab) => [tab.path, ...(tab.aliases ?? [])]),
);

/** True when a route belongs to the Wallet section (wallet + its sub-views). */
export function isWalletSectionPath(path: string): boolean {
  return WALLET_SECTION_PATHS.has(normalizePath(path));
}

function activeTabId(path: string): string {
  const normalized = normalizePath(path);
  const match = WALLET_SECTION_TABS.find(
    (tab) =>
      tab.path === normalized || (tab.aliases ?? []).includes(normalized),
  );
  return match?.id ?? "wallet";
}

function navigate(path: string): void {
  try {
    if (typeof window === "undefined") return;
    if (window.location.protocol === "file:") {
      window.location.hash = path;
    } else {
      window.history.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  } catch {
    // Sandboxed navigation is best-effort.
  }
}

export function WalletSectionNav({
  activePath,
}: {
  activePath: string;
}): React.JSX.Element {
  const active = activeTabId(activePath);
  return (
    <nav
      aria-label="Wallet sections"
      data-testid="wallet-section-nav"
      className="flex shrink-0 items-center gap-1 border-b border-border/45 px-3 py-2"
    >
      {WALLET_SECTION_TABS.map((tab) => {
        const isActive = tab.id === active;
        return (
          <Button
            key={tab.id}
            aria-current={isActive ? "page" : undefined}
            onClick={() => {
              if (!isActive) navigate(tab.path);
            }}
            variant="ghost"
            size="sm"
            className={cn(
              "h-auto rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              isActive
                ? "bg-accent/15 text-accent"
                : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
            )}
          >
            {tab.label}
          </Button>
        );
      })}
    </nav>
  );
}
