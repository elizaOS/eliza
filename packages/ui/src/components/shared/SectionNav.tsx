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
import { shellHistory } from "../../surface-realm-channel";
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

/**
 * Push a section route and notify the router. Shared by every section strip
 * (registry-driven {@link SectionNav} and static-entry families like Character)
 * so hash-vs-history routing is decided in exactly one place. `file:` origins
 * (packaged desktop) route through the hash; everything else pushes history and
 * fires `popstate` so the App's path listener re-resolves the active view.
 */
export function navigateToSectionPath(path: string): void {
  if (typeof window === "undefined") return;
  if (window.location.protocol === "file:") {
    window.location.hash = path;
  } else {
    shellHistory.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

/**
 * A single ghost tab within a {@link SectionTabStrip}. Shared so the doctrine
 * tab styling (active `bg-accent/15 text-accent`, inactive neutral → neutral/
 * opacity hover) lives in exactly one place across every section-nav consumer.
 */
export function SectionNavTab({
  label,
  isActive,
  onSelect,
}: {
  label: React.ReactNode;
  isActive: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <Button
      aria-current={isActive ? "page" : undefined}
      onClick={() => {
        if (!isActive) onSelect();
      }}
      variant="ghost"
      size="sm"
      className={cn(
        "h-auto shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        isActive
          ? "bg-accent/15 text-accent"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
    >
      {label}
    </Button>
  );
}

/**
 * The presentational section-tab strip: a horizontal `nav` of ghost tabs, one
 * per entry, marked active by `activeId`. Purely presentational — it does not
 * know where the tabs come from (app-shell pages, the settings registry, …) or
 * how selection navigates; callers own that. Both the registry-driven
 * {@link SectionNav} and the Settings section-nav render through THIS strip so
 * the doctrine geometry + ghost-tab styling stay identical everywhere.
 *
 * Renders `null` for a section with fewer than two entries (one tab is not a
 * nav; the header alone suffices).
 */
export function SectionTabStrip({
  entries,
  activeId,
  onSelect,
  testId,
  ariaLabel,
  className,
}: {
  entries: readonly { id: string; label: React.ReactNode }[];
  activeId: string;
  onSelect: (id: string) => void;
  /** `data-testid` for the nav landmark (e.g. `section-nav-wallet`). */
  testId?: string;
  /** Accessible name for the nav landmark. */
  ariaLabel: string;
  className?: string;
}): React.JSX.Element | null {
  // A single-entry section is just its header; no secondary nav to render.
  if (entries.length < 2) return null;
  return (
    <nav
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-1 overflow-x-auto px-3 py-2",
        className,
      )}
    >
      {entries.map((entry) => (
        <SectionNavTab
          key={entry.id}
          label={entry.label}
          isActive={entry.id === activeId}
          onSelect={() => onSelect(entry.id)}
        />
      ))}
    </nav>
  );
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
  const active = activeTabId(activePath, tabs);
  return (
    <SectionTabStrip
      entries={tabs}
      activeId={active}
      onSelect={(id) => {
        const tab = tabs.find((candidate) => candidate.id === id);
        if (tab) navigateToSectionPath(tab.path);
      }}
      testId={`section-nav-${group}`}
      ariaLabel={ariaLabel ?? `${group} sections`}
      className={className}
    />
  );
}
