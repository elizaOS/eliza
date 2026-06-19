import { ArrowLeft } from "lucide-react";
import type * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { ContentLayout } from "../../layouts/content-layout";
import { cn } from "../../lib/utils";
import { useApp } from "../../state";
import { PagePanel } from "../composites/page-panel";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../settings/settings-layout";
import {
  getAllSettingsSections,
  readSettingsHashSection,
  replaceSettingsHash,
  SECTION_HUE_MEDALLION_CLASS,
  SETTINGS_GROUP_LABEL,
  SETTINGS_GROUP_ORDER,
  type SettingsSectionDef,
  type SettingsSectionGroup,
  settingsSectionLabel,
  settingsSectionTitle,
} from "../settings/settings-sections";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

type Translate = (key: string, vars?: Record<string, unknown>) => string;

type GroupedSections = {
  group: SettingsSectionGroup;
  items: SettingsSectionDef[];
}[];

function groupSections(sections: SettingsSectionDef[]): GroupedSections {
  const map = new Map<SettingsSectionGroup, SettingsSectionDef[]>();
  for (const group of SETTINGS_GROUP_ORDER) map.set(group, []);
  for (const section of sections) map.get(section.group)?.push(section);
  return SETTINGS_GROUP_ORDER.map((group) => ({
    group,
    items: map.get(group) ?? [],
  })).filter((entry) => entry.items.length > 0);
}

/** Status chip shown on a nav row when cheap to derive. */
function sectionChip(
  section: SettingsSectionDef,
  walletEnabled: boolean | undefined,
): string | null {
  if (section.id === "wallet-rpc") return walletEnabled ? "On" : null;
  return null;
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent ring-1 ring-accent/20">
      {children}
    </span>
  );
}

/**
 * One navigation entry. Renders as a tappable list row on mobile and a compact
 * rail item on desktop, sharing a single agent-surface registration so the
 * agent can open any section by id from chat.
 */
function SettingsNavItem({
  section,
  label,
  chip,
  active,
  variant,
  onSelect,
}: {
  section: SettingsSectionDef;
  label: string;
  chip: string | null;
  active: boolean;
  variant: "list" | "rail";
  onSelect: (id: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `section-${section.id}`,
    role: "card",
    label,
    group: "settings-sections",
    description: `Open the ${label} settings section`,
    onActivate: () => onSelect(section.id),
  });
  const Icon = section.icon;

  if (variant === "list") {
    return (
      <SettingsRow
        icon={Icon}
        iconClassName={SECTION_HUE_MEDALLION_CLASS[section.hue]}
        label={label}
        onClick={() => onSelect(section.id)}
        buttonRef={ref}
        buttonProps={agentProps}
        trailing={chip ? <Chip>{chip}</Chip> : undefined}
        chevron={!chip}
      />
    );
  }

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onSelect(section.id)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
        active
          ? "bg-accent/12 font-medium text-accent"
          : "text-txt hover:bg-surface",
      )}
      {...agentProps}
    >
      <span
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
          active
            ? "bg-accent/15 text-accent"
            : SECTION_HUE_MEDALLION_CLASS[section.hue],
        )}
      >
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {chip ? <Chip>{chip}</Chip> : null}
    </button>
  );
}

function SectionBackButton({ onBack }: { onBack: () => void }) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "section-back",
    role: "button",
    label: "Back to Settings",
    description: "Return to the settings hub",
    onActivate: onBack,
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onBack}
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-txt transition-colors hover:border-accent/40 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      {...agentProps}
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      Settings
    </button>
  );
}

/** The active section's body: optional back, header (icon + title), content. */
function SettingsSectionContent({
  section,
  t,
  onBack,
}: {
  section: SettingsSectionDef;
  t: Translate;
  onBack?: () => void;
}) {
  const Component = section.Component;
  const Icon = section.icon;
  const title = settingsSectionTitle(section, t);
  return (
    <div id={section.id}>
      {onBack ? (
        <div className="mb-4">
          <SectionBackButton onBack={onBack} />
        </div>
      ) : null}
      <div className="mb-4 flex items-center gap-3">
        <div
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-md",
            SECTION_HUE_MEDALLION_CLASS[section.hue],
          )}
        >
          <Icon className="h-5 w-5" aria-hidden />
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-txt-strong">
          {title}
        </h1>
      </div>
      <PagePanel variant="section">
        <div className={cn("p-4 sm:p-5", section.bodyClassName)}>
          <Component />
        </div>
      </PagePanel>
    </div>
  );
}

function MobileHub({
  grouped,
  t,
  walletEnabled,
  onSelect,
}: {
  grouped: GroupedSections;
  t: Translate;
  walletEnabled: boolean | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="w-full pb-32">
      <h1 className="mb-5 text-2xl font-semibold tracking-tight text-txt-strong">
        {t("nav.settings", { defaultValue: "Settings" })}
      </h1>
      <SettingsStack>
        {grouped.map(({ group, items }) => (
          <SettingsGroup key={group} title={SETTINGS_GROUP_LABEL[group]}>
            {items.map((section) => (
              <SettingsNavItem
                key={section.id}
                section={section}
                label={settingsSectionLabel(section, t)}
                chip={sectionChip(section, walletEnabled)}
                active={false}
                variant="list"
                onSelect={onSelect}
              />
            ))}
          </SettingsGroup>
        ))}
      </SettingsStack>
    </div>
  );
}

function DesktopLayout({
  grouped,
  t,
  walletEnabled,
  activeId,
  activeSection,
  onSelect,
}: {
  grouped: GroupedSections;
  t: Translate;
  walletEnabled: boolean | undefined;
  activeId: string | null;
  activeSection: SettingsSectionDef | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex w-full gap-7 pb-32">
      <nav className="w-60 shrink-0" aria-label="Settings sections">
        <div className="sticky top-2 space-y-5">
          <h1 className="px-2.5 text-lg font-semibold tracking-tight text-txt-strong">
            {t("nav.settings", { defaultValue: "Settings" })}
          </h1>
          {grouped.map(({ group, items }) => (
            <div key={group}>
              <h2 className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
                {SETTINGS_GROUP_LABEL[group]}
              </h2>
              <div className="space-y-0.5">
                {items.map((section) => (
                  <SettingsNavItem
                    key={section.id}
                    section={section}
                    label={settingsSectionLabel(section, t)}
                    chip={sectionChip(section, walletEnabled)}
                    active={section.id === activeId}
                    variant="rail"
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </nav>
      <div className="min-w-0 flex-1">
        {activeSection ? (
          <SettingsSectionContent section={activeSection} t={t} />
        ) : null}
      </div>
    </div>
  );
}

export function SettingsView({
  inModal,
  initialSection,
}: {
  inModal?: boolean;
  onClose?: () => void;
  initialSection?: string;
} = {}) {
  const { t, loadPlugins, walletEnabled } = useApp();
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [activeSection, setActiveSection] = useState<string | null>(
    () => initialSection ?? readSettingsHashSection(),
  );

  const visibleSections = useMemo(() => {
    return getAllSettingsSections().filter((section) => {
      if (section.id === "wallet-rpc" && walletEnabled === false) return false;
      return true;
    });
  }, [walletEnabled]);
  const visibleSectionIds = useMemo(
    () => new Set(visibleSections.map((section) => section.id)),
    [visibleSections],
  );
  const grouped = useMemo(
    () => groupSections(visibleSections),
    [visibleSections],
  );

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  const openSection = useCallback((sectionId: string) => {
    setActiveSection(sectionId);
    replaceSettingsHash(sectionId);
  }, []);

  const backToHub = useCallback(() => {
    setActiveSection(null);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", "#");
    }
  }, []);

  useEffect(() => {
    if (!initialSection) return;
    openSection(initialSection);
  }, [initialSection, openSection]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleHashChange = () => {
      const nextSection = readSettingsHashSection();
      if (nextSection && visibleSectionIds.has(nextSection)) {
        setActiveSection(nextSection);
      } else {
        setActiveSection(null);
      }
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [visibleSectionIds]);

  const activeSectionDef: SettingsSectionDef | null =
    activeSection && visibleSectionIds.has(activeSection)
      ? (visibleSections.find((section) => section.id === activeSection) ??
        null)
      : null;

  // Desktop keeps a section selected in the detail pane; mobile shows the
  // grouped list until a row is tapped.
  const desktopSection = activeSectionDef ?? visibleSections[0] ?? null;

  return (
    <ShellViewAgentSurface viewId="settings">
      <ContentLayout inModal={inModal}>
        <div data-testid="settings-shell">
          {isDesktop ? (
            <DesktopLayout
              grouped={grouped}
              t={t}
              walletEnabled={walletEnabled}
              activeId={desktopSection?.id ?? null}
              activeSection={desktopSection}
              onSelect={openSection}
            />
          ) : activeSectionDef ? (
            <div className="w-full pb-32">
              <SettingsSectionContent
                section={activeSectionDef}
                t={t}
                onBack={backToHub}
              />
            </div>
          ) : (
            <MobileHub
              grouped={grouped}
              t={t}
              walletEnabled={walletEnabled}
              onSelect={openSection}
            />
          )}
        </div>
      </ContentLayout>
    </ShellViewAgentSurface>
  );
}
