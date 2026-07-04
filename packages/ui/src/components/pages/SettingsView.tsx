/**
 * The Settings view (`/settings`): a sectioned settings surface that adapts
 * between a two-pane rail+detail layout on wide/landscape viewports and a
 * single-column hub on narrow ones. Section content is lazy-loaded and gated by
 * `isViewVisible`; `initialSection` deep-links a specific pane. Also reusable in
 * modal form (`inModal`).
 */
import { isViewVisible } from "@elizaos/core";
import { ArrowLeft } from "lucide-react";
import type * as React from "react";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { listExtraSettingsGroups } from "../../cloud/settings/cloud-settings-group";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { ContentLayout } from "../../layouts/content-layout";
import { cn } from "../../lib/utils";
import { isAndroidCloudBuild } from "../../platform/android-runtime";
import { useAppSelectorShallow } from "../../state";
import { useEnabledViewKinds } from "../../state/useViewKinds";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../settings/settings-layout";
import {
  getAllSettingsSections,
  readSettingsHashSection,
  replaceSettingsHash,
  SECTION_TONE_ICON_CLASS,
  SETTINGS_GROUP_LABEL,
  SETTINGS_GROUP_ORDER,
  type SettingsSectionDef,
  settingsSectionLabel,
  settingsSectionTitle,
} from "../settings/settings-sections";
import { ViewHeader } from "../shared/ViewHeader";
import { Button } from "../ui/button";
import { ErrorBoundary } from "../ui/error-boundary";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

type Translate = (key: string, vars?: Record<string, unknown>) => string;

type GroupedSections = {
  group: string;
  label: string;
  items: SettingsSectionDef[];
}[];

function isCloudThemedSettingsSection(section: SettingsSectionDef): boolean {
  // The id-prefix intentionally also covers cloud-owned panes registered under
  // non-cloud groups (cloud-security / cloud-plugin-grants under "security",
  // cloud-connectors under "agent"): their bodies hardcode light-on-dark
  // styling (text-white, white/10 borders, bg-black/40) and need the dark
  // theme-cloud island to stay readable.
  return (
    section.id.startsWith("cloud-") ||
    section.group === "cloud" ||
    section.group === "developer"
  );
}

/**
 * Group sections for display. Built-in groups keep their pinned order + labels;
 * any extra group a section declares (e.g. the `cloud` group) is interleaved by
 * its registered order with a registered label. A section whose group is neither
 * built-in nor registered falls into an "Other" bucket so it is never dropped.
 */
function groupSections(sections: SettingsSectionDef[]): GroupedSections {
  const extra = listExtraSettingsGroups();
  // Built-in groups order by their position in the pinned list (0,1,2). Extra
  // groups slot between them by their declared order (e.g. cloud at 1.5 between
  // System=1 and Security=2).
  const orderOf = new Map<string, number>();
  const labels = new Map<string, string>();
  SETTINGS_GROUP_ORDER.forEach((group, index) => {
    orderOf.set(group, index);
    labels.set(group, SETTINGS_GROUP_LABEL[group]);
  });
  for (const group of extra) {
    orderOf.set(group.id, group.order);
    labels.set(group.id, group.label);
  }

  const buckets = new Map<string, SettingsSectionDef[]>();
  for (const section of sections) {
    const bucket = buckets.get(section.group);
    if (bucket) bucket.push(section);
    else buckets.set(section.group, [section]);
  }

  const FALLBACK_ORDER = Number.MAX_SAFE_INTEGER;
  return [...buckets.entries()]
    .map(([group, items]) => ({
      group,
      label: labels.get(group) ?? "Other",
      items,
      order: orderOf.get(group) ?? FALLBACK_ORDER,
    }))
    .filter((entry) => entry.items.length > 0)
    .sort((a, b) => a.order - b.order)
    .map(({ group, label, items }) => ({ group, label, items }));
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
    <span className="inline-flex items-center text-[11px] font-medium text-accent">
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
        iconClassName={SECTION_TONE_ICON_CLASS[section.tone]}
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
    <Button
      ref={ref}
      variant="ghost"
      size="sm"
      onClick={() => onSelect(section.id)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "h-auto w-full justify-start gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
        active ? "font-medium text-accent" : "text-txt hover:bg-surface",
      )}
      {...agentProps}
    >
      <Icon
        className={cn(
          "h-4 w-4 shrink-0",
          active ? "text-accent" : SECTION_TONE_ICON_CLASS[section.tone],
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {chip ? <Chip>{chip}</Chip> : null}
    </Button>
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
    <Button
      ref={ref}
      variant="ghost"
      size="sm"
      onClick={onBack}
      className="h-9 gap-1.5 rounded-md px-2 text-xs font-medium text-muted transition-colors hover:bg-surface hover:text-accent"
      {...agentProps}
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      Settings
    </Button>
  );
}

/**
 * Loading placeholder for a lazily-loaded section body (#11351). Deliberately
 * minimal — a single muted, `aria-busy` line so the split is visually quiet and
 * never shifts the section header or nav rail while the chunk resolves.
 */
function SettingsSectionLoading() {
  return (
    <div
      aria-busy="true"
      className="flex min-h-[6rem] items-center text-sm text-muted"
    />
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
  const cloudThemed = isCloudThemedSettingsSection(section);
  return (
    <div
      id={section.id}
      className={cn(
        cloudThemed &&
          "theme-cloud min-h-[calc(100dvh-8rem)] bg-black px-3 py-4 text-white sm:px-5 sm:py-5",
      )}
    >
      {onBack ? (
        <div className="mb-1.5">
          <SectionBackButton onBack={onBack} />
        </div>
      ) : null}
      <div className="mb-5 flex items-center gap-2.5">
        <Icon className="h-5 w-5 shrink-0 text-muted/80" aria-hidden />
        <h1 className="text-lg font-semibold tracking-tight text-txt-strong">
          {title}
        </h1>
      </div>
      {/* Flat — no card/border. The shell owns the page's horizontal padding. */}
      <div className={section.bodyClassName}>
        <ErrorBoundary
          key={section.id}
          fallback={(error, reset) => (
            <SettingsSectionFallback
              title={title}
              error={error}
              onRetry={reset}
              t={t}
            />
          )}
        >
          {/* Section bodies are `React.lazy` (#11351); the boundary keeps the
              split transparent with a minimal, unobtrusive loading state. */}
          <Suspense fallback={<SettingsSectionLoading />}>
            <Component />
          </Suspense>
        </ErrorBoundary>
      </div>
    </div>
  );
}

/**
 * Inline per-section error fallback. A section that throws on mount/render must
 * degrade to this card — never blank the whole shell — so the settings nav rail
 * and every other section stay interactive. Uses the settings `warn` token
 * vocabulary for visual consistency with the rest of the surface.
 */
function SettingsSectionFallback({
  title,
  error,
  onRetry,
  t,
}: {
  title: string;
  error: Error;
  onRetry: () => void;
  t: Translate;
}) {
  return (
    <div
      role="alert"
      data-testid="settings-section-error"
      className="flex flex-col items-start gap-2 rounded-md border border-warn/30 bg-warn/12 p-4 text-left"
    >
      <p className="text-sm font-semibold text-warn">
        {t("settings.sectionFailed", {
          defaultValue: "{{title}} failed to load",
          title,
        })}
      </p>
      <p className="text-xs-tight text-muted max-w-prose break-words">
        {error.message}
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        className="mt-1 h-9 rounded-md border-border bg-card px-3 text-xs font-medium text-txt transition-colors hover:border-accent hover:text-accent"
      >
        {t("settings.sectionRetry", { defaultValue: "Retry" })}
      </Button>
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
      {/* Top-level view header: centered "Settings" title with a launcher back
          arrow on mobile (iOS-style nav bar). Only the single-column hub renders
          it — the desktop split already owns its own "Settings" H1 in the rail,
          and the per-section view keeps its own SectionBackButton (section→hub). */}
      <ViewHeader
        title={t("nav.settings", { defaultValue: "Settings" })}
        className="mb-2"
      />
      <SettingsStack>
        {grouped.map(({ group, label, items }) => (
          <SettingsGroup key={group} title={label}>
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
          <h1 className="min-h-8 px-2.5 pl-12 text-lg font-semibold tracking-tight text-txt-strong">
            {t("nav.settings", { defaultValue: "Settings" })}
          </h1>
          {grouped.map(({ group, label, items }) => (
            <div key={group}>
              <h2 className="mb-1 px-2.5 text-xs font-medium text-muted">
                {label}
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
  const { t, loadPlugins, walletEnabled } = useAppSelectorShallow((s) => ({
    t: s.t,
    loadPlugins: s.loadPlugins,
    walletEnabled: s.walletEnabled,
  }));
  // The two-pane (rail + detail) layout needs real horizontal room. A plain
  // `min-width: 1024px` check sends a landscape phone (≈900px wide, but with
  // ample horizontal space) to the single-column hub, and can push a narrow
  // portrait tablet into the cramped two-pane. Combine width with orientation:
  // two-pane when the viewport is genuinely wide (≥1024, any orientation, e.g. a
  // portrait desktop monitor) OR when it is landscape and at least tablet-wide.
  const isWide = useMediaQuery("(min-width: 1024px)");
  const isWideLandscape = useMediaQuery(
    "(min-width: 768px) and (orientation: landscape)",
  );
  const isTwoPane = isWide || isWideLandscape;
  const enabledKinds = useEnabledViewKinds();
  const [activeSection, setActiveSection] = useState<string | null>(
    () => initialSection ?? readSettingsHashSection(),
  );

  const visibleSections = useMemo(() => {
    return getAllSettingsSections().filter((section) => {
      if (section.id === "wallet-rpc" && walletEnabled === false) return false;
      if (!isViewVisible(section, enabledKinds)) return false;
      if (section.hideOnCloud && isAndroidCloudBuild()) return false;
      return true;
    });
  }, [walletEnabled, enabledKinds]);
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
      <ContentLayout inModal={inModal} contentClassName="max-sm:pt-1">
        <div data-testid="settings-shell">
          {isTwoPane ? (
            <DesktopLayout
              grouped={grouped}
              t={t}
              walletEnabled={walletEnabled}
              activeId={desktopSection?.id ?? null}
              activeSection={desktopSection}
              onSelect={openSection}
            />
          ) : activeSectionDef ? (
            <div className="w-full pb-32 max-sm:pt-8">
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
