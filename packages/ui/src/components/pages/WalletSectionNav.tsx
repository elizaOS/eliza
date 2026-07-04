/**
 * Wallet section navigation renders sub-tabs from app-shell pages that declare
 * the wallet group. The wallet inventory page owns the root `/wallet` tab while
 * plugin pages join or leave the section through their own registration data.
 */

import { useSyncExternalStore } from "react";
import {
  type AppShellPageRegistration,
  getAppShellPageRegistrySnapshot,
  listAppShellPages,
  subscribeAppShellPages,
} from "../../app-shell-registry";
import { cn } from "../../lib/utils";
import { ViewBackButton } from "../shared/ViewHeader";
import { Button } from "../ui/button";

interface WalletSectionTab {
  id: string;
  label: string;
  path: string;
  /** Extra paths that should also mark this tab active. */
  aliases?: string[];
}

const WALLET_SECTION_GROUP = "wallet";
const WALLET_ROOT_PATH = "/wallet";

function normalizePath(path: string): string {
  const trimmed = (path || "/").split(/[?#]/, 1)[0].toLowerCase();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 && withSlash.endsWith("/")
    ? withSlash.slice(0, -1)
    : withSlash;
}

function compareWalletRegistrations(
  a: AppShellPageRegistration,
  b: AppShellPageRegistration,
): number {
  return (
    (a.order ?? 100) - (b.order ?? 100) ||
    a.label.localeCompare(b.label) ||
    a.id.localeCompare(b.id)
  );
}

function walletRegistrationToTab(
  registration: AppShellPageRegistration,
): WalletSectionTab {
  const registrationPath = normalizePath(registration.path);
  if (registrationPath === "/inventory") {
    return {
      id: registration.id,
      label: registration.label,
      path: WALLET_ROOT_PATH,
      aliases: [registrationPath],
    };
  }
  return {
    id: registration.id,
    label: registration.label,
    path: registrationPath,
  };
}

export function walletSectionTabs(): WalletSectionTab[] {
  return listAppShellPages()
    .filter((registration) => registration.group === WALLET_SECTION_GROUP)
    .sort(compareWalletRegistrations)
    .map(walletRegistrationToTab);
}

function walletSectionPathSet(): Set<string> {
  return new Set(
    walletSectionTabs().flatMap((tab) => [tab.path, ...(tab.aliases ?? [])]),
  );
}

/** True when a route belongs to the Wallet section (wallet + its sub-views). */
export function isWalletSectionPath(path: string): boolean {
  return walletSectionPathSet().has(normalizePath(path));
}

function activeTabId(path: string, tabs: readonly WalletSectionTab[]): string {
  const normalized = normalizePath(path);
  const match = tabs.find(
    (tab) =>
      tab.path === normalized || (tab.aliases ?? []).includes(normalized),
  );
  return match?.id ?? tabs[0]?.id ?? "";
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
  useSyncExternalStore(
    subscribeAppShellPages,
    getAppShellPageRegistrySnapshot,
    getAppShellPageRegistrySnapshot,
  );
  const tabs = walletSectionTabs();
  const active = activeTabId(activePath, tabs);
  return (
    <nav
      aria-label="Wallet sections"
      data-testid="wallet-section-nav"
      className="flex shrink-0 items-center gap-1 border-b border-border/45 px-3 py-2"
    >
      {/* Back-to-launcher control — the Wallet family (wallet/perps/predictions)
       *  renders this shared tab strip as its header instead of a ViewHeader, so
       *  it owns the launcher back button the other top-level views get from
       *  ViewHeader. Without it there is no way back to the launcher on mobile. */}
      <ViewBackButton className="mr-1" />
      {tabs.map((tab) => {
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
