/**
 * Renders keyboard-navigable persistent settings navigation for desktop while
 * mobile retains its hub-style navigation.
 */

import { Check } from "lucide-react";
import { useCallback, useRef } from "react";

import { ViewBackButton } from "../shared/ViewHeader";
import { Button } from "../ui/button";
import type { GroupedSettingsSections } from "./settings-sections";

interface DesktopSettingsNavigationProps {
  grouped: GroupedSettingsSections;
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Omit when Settings owns a detached window with no launcher history. */
  onBack?: () => void;
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
    <nav
      aria-label={settingsLabel}
      data-testid="desktop-settings-navigation"
      className="flex h-full min-h-0 w-60 min-w-60 max-w-60 shrink-0 flex-col overflow-hidden border-r border-border/60 bg-[var(--settings-panel)]"
    >
      <div className="grid h-12 shrink-0 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center border-b border-border/50 px-2">
        {onBack ? (
          <ViewBackButton
            onBack={onBack}
            label="Back to launcher"
            className="shrink-0 text-muted hover:!bg-[var(--settings-fill)] hover:text-txt-strong focus-visible:!bg-[var(--settings-fill)] focus-visible:!ring-2 focus-visible:!ring-inset focus-visible:!ring-[var(--settings-ring)]"
          />
        ) : (
          <span aria-hidden />
        )}
        <span className="truncate text-center text-sm font-semibold text-txt-strong">
          {settingsLabel}
        </span>
        <span aria-hidden />
      </div>

      <div
        data-scroll-cert-scroller
        className="custom-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-3 py-4"
      >
        {grouped.map(({ group, label: groupLabel, items }) => (
          <section
            key={group}
            data-testid={`desktop-settings-group-${group}`}
            className="flex flex-col gap-1"
          >
            <h2 className="px-3 text-2xs font-medium uppercase tracking-[0.12em] text-muted/70">
              {groupLabel}
            </h2>
            <div className="flex flex-col gap-0.5">
              {items.map((section) => {
                const Icon = section.icon;
                const sectionLabel = label(section.label, section.defaultLabel);
                const isActive = section.id === activeId;

                return (
                  <Button
                    variant="settingsRow"
                    size="touch"
                    align="start"
                    data-state={isActive ? "on" : "off"}
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
                      }
                    }}
                    className="settings-nav-item group w-full min-w-0"
                  >
                    <Icon aria-hidden className="size-4 shrink-0 opacity-70" />
                    <span className="min-w-0 flex-1 truncate">
                      {sectionLabel}
                    </span>
                    {isActive ? (
                      <Check
                        aria-hidden
                        data-testid={`desktop-settings-check-${section.id}`}
                        className="size-4 shrink-0 opacity-70"
                      />
                    ) : null}
                  </Button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </nav>
  );
}
