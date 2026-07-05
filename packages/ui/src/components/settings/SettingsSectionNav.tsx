/**
 * Settings section navigation (#13590).
 *
 * The old Settings view carried a persistent desktop LEFT RAIL (`nav.w-60`) with
 * its own inline `<h1>Settings</h1>` and a divergent mobile hub. The redesign
 * doctrine (#13451/#13586/#13452) folds that rail into a single top-bar section
 * nav that sits BENEATH the shared `ViewHeader` — the same Wallet pattern
 * (`WalletSectionNav`), one nav + one detail region for every form factor.
 *
 * Settings is NOT an app-shell-page family, so it cannot drive the registry-
 * bound `SectionNav` (which reads `listAppShellPages()` + path routing).
 * Settings owns its own hash-routed registry (`settings-sections.ts`) grouped
 * into Agent / System / Security / Cloud fold groups. To avoid a parallel
 * tab renderer, this component reuses the SAME presentational primitive the
 * app-shell family uses — `SectionTabStrip` from `../shared/SectionNav` — for
 * the doctrine ghost-tab geometry + styling. It only supplies the grouped
 * settings entries + hash-selection; the strip owns the pixels.
 *
 * The strip is a single horizontal, scrollable row of section tabs delimited by
 * their group label, so Agent/System/Security/Cloud read as folded clusters
 * without a second nav level. On mobile it scrolls; on desktop it wraps to the
 * available width. A group with a single section still shows its lone tab (the
 * whole view is the "section" here, unlike the app-shell single-member case).
 */

import { cn } from "../../lib/utils";
import { SectionNavTab } from "../shared/SectionNav";
import type { GroupedSettingsSections } from "./settings-sections";

/**
 * The horizontal grouped section strip. Renders one ghost tab per section,
 * clustered under its group label, marking `activeId` active. `onSelect` opens
 * that section (hash-routed by the caller). Purely presentational otherwise —
 * it defers every tab's pixels to the shared `SectionNavTab`.
 */
export function SettingsSectionNav({
  grouped,
  activeId,
  onSelect,
  label,
  className,
}: {
  grouped: GroupedSettingsSections;
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Rendered group label + accessible section label (i18n-resolved by caller). */
  label: (labelKey: string, fallback: string) => string;
  className?: string;
}): React.JSX.Element {
  return (
    <nav
      aria-label="Settings sections"
      data-testid="settings-section-nav"
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-4 overflow-x-auto px-3 py-2",
        className,
      )}
    >
      {grouped.map(({ group, label: groupLabel, items }) => (
        <div key={group} className="flex shrink-0 items-center gap-1.5">
          <span className="shrink-0 select-none pr-0.5 text-2xs font-medium uppercase tracking-wide text-muted/70">
            {groupLabel}
          </span>
          {items.map((section) => (
            <SectionNavTab
              key={section.id}
              label={label(section.label, section.defaultLabel)}
              isActive={section.id === activeId}
              onSelect={() => onSelect(section.id)}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}
