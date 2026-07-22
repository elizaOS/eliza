import { useCallback, useRef } from "react";

import { cn } from "../../lib/utils";
import { Sidebar } from "../composites/sidebar";
import { ViewBackButton } from "../shared/ViewHeader";
import {
  type GroupedSettingsSections,
  SECTION_HUE_MEDALLION_CLASS,
} from "./settings-sections";

interface DesktopSettingsNavigationProps {
  grouped: GroupedSettingsSections;
  activeId: string | null;
  onSelect: (id: string) => void;
  onBack: () => void;
  settingsLabel: string;
  label: (labelKey: string, fallback: string) => string;
}

/**
 * Persistent navigation for the desktop settings workspace. Arrow keys move
 * focus through the complete rail while Enter/Space activates the focused
 * destination. Mobile continues to use SettingsHubList instead.
 */
export function DesktopSettingsNavigation({
  grouped,
  activeId,
  onSelect,
  onBack,
  settingsLabel,
  label,
}: DesktopSettingsNavigationProps): React.JSX.Element {
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const sectionIds = grouped.flatMap(({ items }) =>
    items.map((section) => section.id),
  );

  const setItemRef = useCallback(
    (id: string, node: HTMLButtonElement | null) => {
      if (node) itemRefs.current.set(id, node);
      else itemRefs.current.delete(id);
    },
    [],
  );

  const focusRelativeItem = (currentId: string, offset: number) => {
    const currentIndex = sectionIds.indexOf(currentId);
    if (currentIndex < 0 || sectionIds.length === 0) return;
    const nextIndex =
      (currentIndex + offset + sectionIds.length) % sectionIds.length;
    itemRefs.current.get(sectionIds[nextIndex])?.focus();
  };

  return (
    <Sidebar
      testId="desktop-settings-fixed-pane"
      collapsible={false}
      className="!m-0 !h-full !w-60 !min-w-60 !rounded-none !border-0 !bg-transparent !shadow-none"
      bodyClassName="overflow-y-auto"
    >
      <nav
        aria-label="Settings sections"
        data-testid="desktop-settings-navigation"
        className="flex min-h-full w-60 shrink-0 flex-col gap-6 border-r border-border/60 px-3 py-6"
      >
        <div className="flex items-start gap-1 px-1">
          <ViewBackButton
            onBack={onBack}
            label="Back to launcher"
            className="mt-0.5 shrink-0"
          />
          <div className="min-w-0 pt-1">
            <p className="text-sm font-semibold tracking-tight text-txt-strong">
              {settingsLabel}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Agent, app, and privacy controls
            </p>
          </div>
        </div>

        {grouped.map(({ group, label: groupLabel, items }) => (
          <section key={group} data-testid={`desktop-settings-group-${group}`}>
            <h2 className="mb-1 px-2 text-2xs font-medium uppercase tracking-wide text-muted/70">
              {groupLabel}
            </h2>
            <div className="flex flex-col gap-0.5">
              {items.map((section) => {
                const Icon = section.icon;
                const sectionLabel = label(section.label, section.defaultLabel);
                const isActive = section.id === activeId;

                return (
                  <button
                    key={section.id}
                    ref={(node) => setItemRef(section.id, node)}
                    type="button"
                    data-testid={`desktop-settings-item-${section.id}`}
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => onSelect(section.id)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        focusRelativeItem(section.id, 1);
                      } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        focusRelativeItem(section.id, -1);
                      } else if (event.key === "Enter") {
                        event.preventDefault();
                        onSelect(section.id);
                      }
                    }}
                    className={cn(
                      "group flex min-h-11 w-full items-center gap-2.5 rounded-md border border-transparent px-2 py-2 text-left text-sm transition-colors",
                      "text-muted hover:bg-surface/70 hover:text-txt-strong",
                      isActive &&
                        "bg-accent/10 font-medium text-txt-strong hover:bg-accent/12",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-md",
                        SECTION_HUE_MEDALLION_CLASS[section.hue],
                        !isActive && "opacity-80 group-hover:opacity-100",
                      )}
                    >
                      <Icon className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {sectionLabel}
                    </span>
                    {isActive ? (
                      <span
                        aria-hidden
                        className="size-1.5 shrink-0 rounded-full bg-accent"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </nav>
    </Sidebar>
  );
}
