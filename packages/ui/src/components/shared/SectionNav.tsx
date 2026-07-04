/**
 * Generalized secondary section-navigation strip (#13586).
 *
 * Extracted from the Wallet-specific `WalletSectionNav` so any view family can
 * fold sibling app-shell pages into a single grouped tab strip. A "section" is
 * the set of app-shell page registrations that declare the same `group`; this
 * component reads `listAppShellPages()`, filters by the `group` prop, sorts
 * order → label → id, and renders ghost tabs (active `bg-accent/15 text-accent`,
 * inactive neutral → neutral/opacity hover).
 *
 * This strip is SECONDARY nav: it renders BENEATH a `ViewHeader` (icon-only
 * back + centered title), never in place of it. A section with a single member
 * renders no strip at all — one tab is not a nav, and the header alone suffices.
 *
 * Path/alias handling mirrors `WalletSectionNav`: a page whose registered path
 * differs from its canonical section route (e.g. Wallet's `/inventory`
 * registration owning the `/wallet` root) supplies aliases so both routes mark
 * the tab active.
 */

import { useSyncExternalStore } from "react";
import {
  type AppShellPageRegistration,
  getAppShellPageRegistrySnapshot,
  listAppShellPages,
  subscribeAppShellPages,
} from "../../app-shell-registry";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

/** A single tab within a section strip. */
export interface SectionTab {
  id: string;
  label: string;
  path: string;
  /** Extra paths that should also mark this tab active. */
  aliases?: string[];
}

/**
 * Rewrites a registration's route to a canonical section path. Used by view
 * families (e.g. Wallet) where the root tab registers under a different path
 * than the section's canonical route. Return the rewritten tab, or `null` to
 * use the registration's own path verbatim.
 */
export type SectionPathRewrite = (
  registration: AppShellPageRegistration,
) => SectionTab | null;

export function normalizeSectionPath(path: string): string {
  const trimmed = (path || "/").split(/[?#]/, 1)[0].toLowerCase();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 && withSlash.endsWith("/")
    ? withSlash.slice(0, -1)
    : withSlash;
}

function compareRegistrations(
  a: AppShellPageRegistration,
  b: AppShellPageRegistration,
): number {
  return (
    (a.order ?? 100) - (b.order ?? 100) ||
    a.label.localeCompare(b.label) ||
    a.id.localeCompare(b.id)
  );
}

function registrationToTab(
  registration: AppShellPageRegistration,
  rewrite?: SectionPathRewrite,
): SectionTab {
  const rewritten = rewrite?.(registration);
  if (rewritten) return rewritten;
  return {
    id: registration.id,
    label: registration.label,
    path: normalizeSectionPath(registration.path),
  };
}

/** The tabs for a section, sorted and path-normalized. */
export function sectionTabs(
  group: string,
  rewrite?: SectionPathRewrite,
): SectionTab[] {
  return listAppShellPages()
    .filter((registration) => registration.group === group)
    .sort(compareRegistrations)
    .map((registration) => registrationToTab(registration, rewrite));
}

function sectionPathSet(
  group: string,
  rewrite?: SectionPathRewrite,
): Set<string> {
  return new Set(
    sectionTabs(group, rewrite).flatMap((tab) => [
      tab.path,
      ...(tab.aliases ?? []),
    ]),
  );
}

/** True when a route belongs to the given section (its tab or an alias). */
export function isSectionPath(
  group: string,
  path: string,
  rewrite?: SectionPathRewrite,
): boolean {
  return sectionPathSet(group, rewrite).has(normalizeSectionPath(path));
}

function activeTabId(path: string, tabs: readonly SectionTab[]): string {
  const normalized = normalizeSectionPath(path);
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

/**
 * The secondary section-nav strip. Renders one ghost tab per registered page in
 * `group`, sorted and marked active from `activePath`. Renders `null` when the
 * section has fewer than two members (a single tab is not a nav).
 */
export function SectionNav({
  group,
  activePath,
  rewrite,
  ariaLabel,
  className,
}: {
  group: string;
  activePath: string;
  /** Optional per-registration path rewrite (canonical root aliasing). */
  rewrite?: SectionPathRewrite;
  /** Accessible name for the nav landmark. */
  ariaLabel?: string;
  className?: string;
}): React.JSX.Element | null {
  useSyncExternalStore(
    subscribeAppShellPages,
    getAppShellPageRegistrySnapshot,
    getAppShellPageRegistrySnapshot,
  );
  const tabs = sectionTabs(group, rewrite);
  // A single-member section is just its header; no secondary nav to render.
  if (tabs.length < 2) return null;
  const active = activeTabId(activePath, tabs);
  return (
    <nav
      aria-label={ariaLabel ?? `${group} sections`}
      data-testid={`section-nav-${group}`}
      className={cn("flex shrink-0 items-center gap-1 px-3 py-2", className)}
    >
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
