import { ArrowLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { ContentLayout } from "../../layouts/content-layout";
import { cn } from "../../lib/utils";
import { useApp } from "../../state";
import { PagePanel } from "../composites/page-panel";
import {
  readSettingsHashSection,
  replaceSettingsHash,
  SECTION_HUE_MEDALLION_CLASS,
  SETTINGS_GROUP_LABEL,
  SETTINGS_GROUP_ORDER,
  SETTINGS_SECTIONS,
  type SettingsSectionDef,
  type SettingsSectionGroup,
  settingsSectionLabel,
  settingsSectionTitle,
} from "../settings/settings-sections";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

// Keep section content clear of the bottom-center floating chat pill (~90px).
const HUB_CLASS = "pb-32 w-full max-w-5xl mx-auto";
const SECTION_CLASS = "pb-32 w-full max-w-4xl mx-auto";

type Translate = (key: string, vars?: Record<string, unknown>) => string;

/** Tiny status chip shown on a tile. Derived only where genuinely cheap. */
function tileChip(
  section: SettingsSectionDef,
  walletEnabled: boolean | undefined,
): string | null {
  if (section.id === "wallet-rpc") {
    return walletEnabled ? "enabled" : null;
  }
  return null;
}

function HubTile({
  section,
  label,
  chip,
  onSelect,
}: {
  section: SettingsSectionDef;
  label: string;
  chip: string | null;
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
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onSelect(section.id)}
      className={cn(
        "group relative flex flex-col items-start gap-3 rounded-lg border border-border bg-card p-4 text-left",
        "transition-colors hover:border-accent/40 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
      )}
      {...agentProps}
    >
      <div
        className={cn(
          "flex h-11 w-11 items-center justify-center rounded-md",
          SECTION_HUE_MEDALLION_CLASS[section.hue],
        )}
      >
        <Icon className="h-5 w-5" aria-hidden />
      </div>
      <div className="flex w-full items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold leading-5 text-txt-strong">
          {label}
        </span>
        <ChevronRight
          className="h-4 w-4 shrink-0 text-muted transition-colors group-hover:text-accent"
          aria-hidden
        />
      </div>
      {chip ? (
        <span className="inline-flex items-center rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent ring-1 ring-accent/20">
          {chip}
        </span>
      ) : null}
    </button>
  );
}

function SettingsHub({
  sections,
  t,
  walletEnabled,
  onSelect,
}: {
  sections: SettingsSectionDef[];
  t: Translate;
  walletEnabled: boolean | undefined;
  onSelect: (id: string) => void;
}) {
  const grouped = useMemo(() => {
    const map = new Map<SettingsSectionGroup, SettingsSectionDef[]>();
    for (const group of SETTINGS_GROUP_ORDER) map.set(group, []);
    for (const section of sections) {
      const bucket = map.get(section.group);
      if (bucket) bucket.push(section);
    }
    return SETTINGS_GROUP_ORDER.map((group) => ({
      group,
      items: map.get(group) ?? [],
    })).filter((g) => g.items.length > 0);
  }, [sections]);

  return (
    <div className={HUB_CLASS}>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-txt-strong">
        {t("nav.settings", { defaultValue: "Settings" })}
      </h1>
      <div className="mt-6 space-y-8">
        {grouped.map(({ group, items }) => (
          <section key={group}>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
              {SETTINGS_GROUP_LABEL[group]}
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {items.map((section) => (
                <HubTile
                  key={section.id}
                  section={section}
                  label={settingsSectionLabel(section, t)}
                  chip={tileChip(section, walletEnabled)}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
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

function SettingsSectionPage({
  section,
  t,
  onBack,
}: {
  section: SettingsSectionDef;
  t: Translate;
  onBack: () => void;
}) {
  const Component = section.Component;
  const Icon = section.icon;
  const title = settingsSectionTitle(section, t);
  return (
    <div className={SECTION_CLASS}>
      <div className="mb-4 flex items-center gap-3">
        <SectionBackButton onBack={onBack} />
      </div>
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

export function SettingsView({
  inModal,
  initialSection,
}: {
  inModal?: boolean;
  onClose?: () => void;
  initialSection?: string;
} = {}) {
  const { t, loadPlugins, walletEnabled } = useApp();
  const [activeSection, setActiveSection] = useState<string | null>(
    () => initialSection ?? readSettingsHashSection(),
  );

  const visibleSections = useMemo(() => {
    return SETTINGS_SECTIONS.filter((section) => {
      if (section.id === "wallet-rpc" && walletEnabled === false) return false;
      return true;
    });
  }, [walletEnabled]);
  const visibleSectionIds = useMemo(
    () => new Set(visibleSections.map((section) => section.id)),
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

  return (
    <ShellViewAgentSurface viewId="settings">
      <ContentLayout inModal={inModal}>
        {activeSectionDef ? (
          <SettingsSectionPage
            section={activeSectionDef}
            t={t}
            onBack={backToHub}
          />
        ) : (
          <SettingsHub
            sections={visibleSections}
            t={t}
            walletEnabled={walletEnabled}
            onSelect={openSection}
          />
        )}
      </ContentLayout>
    </ShellViewAgentSurface>
  );
}
