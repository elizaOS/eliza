/**
 * The Settings hub — an iOS/Android-style grouped row list that IS the settings
 * main screen. Each group renders as a labelled rounded surface of tappable rows
 * (icon medallion, section label, trailing chevron); tapping a row opens that
 * section as a subview (the SettingsView swaps the hub for the section body and
 * the shared ViewHeader's back returns here). Replaces the old horizontal
 * scroll-strip nav (`SettingsSectionNav`), which buried sections off-screen and
 * had no resting "main view".
 *
 * Purely presentational: grouping, visibility, and hash routing stay in
 * SettingsView / settings-sections.
 */
import { ChevronRight } from "lucide-react";

import { cn } from "../../lib/utils";
import {
  type GroupedSettingsSections,
  SECTION_HUE_MEDALLION_CLASS,
} from "./settings-sections";

export function SettingsHubList({
  grouped,
  onSelect,
  label,
}: {
  grouped: GroupedSettingsSections;
  onSelect: (id: string) => void;
  /** i18n resolver for group + section labels (resolved by the caller). */
  label: (labelKey: string, fallback: string) => string;
}): React.JSX.Element {
  return (
    <nav
      aria-label="Settings sections"
      data-testid="settings-hub-list"
      className="flex w-full flex-col gap-5"
    >
      {grouped.map(({ group, label: groupLabel, items }) => (
        <section key={group} data-testid={`settings-hub-group-${group}`}>
          <h2 className="mb-1.5 px-1 text-2xs font-medium uppercase tracking-wide text-muted/80">
            {groupLabel}
          </h2>
          <div className="overflow-hidden rounded-xl bg-card/60">
            {items.map((section) => {
              const Icon = section.icon;
              const sectionLabel = label(section.label, section.defaultLabel);
              return (
                <button
                  key={section.id}
                  type="button"
                  data-testid={`settings-hub-row-${section.id}`}
                  onClick={() => onSelect(section.id)}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-3 px-3 py-2.5 text-left transition-colors",
                    "hover:bg-surface/80",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-lg",
                      SECTION_HUE_MEDALLION_CLASS[section.hue],
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-txt-strong">
                    {sectionLabel}
                  </span>
                  <ChevronRight
                    aria-hidden
                    className="size-4 shrink-0 text-muted/60"
                  />
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </nav>
  );
}
