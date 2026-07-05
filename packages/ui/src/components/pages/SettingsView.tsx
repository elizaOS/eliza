/**
 * The Settings view (`/settings`): a sectioned settings surface with ONE
 * uniform top bar in every layout (#13590). A shared `ViewHeader` (icon-only
 * back, centered title) sits above a folded top-bar section nav
 * (`SettingsSectionNav`) that replaces the old desktop `w-60` LEFT RAIL and the
 * divergent mobile hub; one nav + one detail region for all form factors.
 *
 * - Hub (no section open): header title = "Settings", back → launcher; the
 *   section nav lets the user pick a section.
 * - Section open: header title = section label, back → hub; the nav keeps the
 *   active section marked.
 *
 * Section content is lazy-loaded and gated by `isViewVisible`; `initialSection`
 * deep-links a specific section. Also reusable in modal form (`inModal`).
 */
import { isViewVisible } from "@elizaos/core";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { ContentLayout } from "../../layouts/content-layout";
import { isAndroidCloudBuild } from "../../platform/android-runtime";
import { useAppSelectorShallow } from "../../state";
import { useEnabledViewKinds } from "../../state/useViewKinds";
import { SettingsSectionNav } from "../settings/SettingsSectionNav";
import {
  type GroupedSettingsSections,
  getAllSettingsSections,
  groupSettingsSections,
  readSettingsHashSection,
  replaceSettingsHash,
  type SettingsSectionDef,
  settingsSectionLabel,
  settingsSectionTitle,
} from "../settings/settings-sections";
import { navigateBackToLauncher, ViewHeader } from "../shared/ViewHeader";
import { Button } from "../ui/button";
import { ErrorBoundary } from "../ui/error-boundary";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

type Translate = (key: string, vars?: Record<string, unknown>) => string;

/**
 * Loading placeholder for a lazily-loaded section body (#11351). Deliberately
 * minimal — a single muted, `aria-busy` line so the split is visually quiet and
 * never shifts the header while the chunk resolves.
 */
function SettingsSectionLoading() {
  return (
    <div
      aria-busy="true"
      className="flex min-h-[6rem] items-center text-sm text-muted"
    />
  );
}

/**
 * The active section's body. The uniform `ViewHeader` lives at the view root
 * (not per-section), so this only renders the lazy section component behind a
 * transparent Suspense + error boundary. One opaque token surface for the whole
 * view — no per-section `theme-cloud bg-black` islands (#13452).
 */
function SettingsSectionContent({
  section,
  t,
}: {
  section: SettingsSectionDef;
  t: Translate;
}) {
  const Component = section.Component;
  const title = settingsSectionTitle(section, t);
  return (
    <div id={section.id} className={section.bodyClassName}>
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
  );
}

/**
 * Inline per-section error fallback. A section that throws on mount/render must
 * degrade to this card — never blank the whole shell — so the settings nav and
 * every other section stay interactive. Uses the settings `warn` token
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

/**
 * A per-section agent-surface registration so the agent can open any section by
 * id from chat (`section-<id>`), independent of which section is currently
 * shown. Renders nothing — it only wires the surface element.
 */
function SettingsSectionSurfaceAnchor({
  section,
  label,
  onSelect,
}: {
  section: SettingsSectionDef;
  label: string;
  onSelect: (id: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `section-${section.id}`,
    role: "button",
    label,
    group: "settings-sections",
    description: `Open the ${label} settings section`,
    onActivate: () => onSelect(section.id),
  });
  return (
    <button
      ref={ref}
      type="button"
      aria-hidden
      tabIndex={-1}
      className="hidden"
      onClick={() => onSelect(section.id)}
      {...agentProps}
    />
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
  const grouped: GroupedSettingsSections = useMemo(
    () => groupSettingsSections(visibleSections),
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

  // Uniform top bar: a hub shows "Settings" with a launcher back; an open
  // section shows its label with a back to the hub. One header, both states.
  const headerTitle = activeSectionDef
    ? settingsSectionTitle(activeSectionDef, t)
    : t("nav.settings", { defaultValue: "Settings" });
  const onBack = activeSectionDef ? backToHub : navigateBackToLauncher;
  const backLabel = activeSectionDef ? "Back to Settings" : "Back to launcher";

  return (
    <ShellViewAgentSurface viewId="settings">
      <ContentLayout inModal={inModal} contentClassName="max-sm:pt-1">
        <div data-testid="settings-shell" className="flex w-full flex-col">
          <ViewHeader
            title={headerTitle}
            onBack={onBack}
            backLabel={backLabel}
            className="px-0"
          />
          {/* The folded top-bar section nav (was the desktop `w-60` rail).
              One strip, grouped by Agent/System/Security/Cloud, for every form
              factor — it self-scrolls on narrow viewports. */}
          <SettingsSectionNav
            grouped={grouped}
            activeId={activeSectionDef?.id ?? null}
            onSelect={openSection}
            label={(labelKey, fallback) =>
              t(labelKey, { defaultValue: fallback })
            }
            className="mb-4 border-b border-border/45 px-0"
          />
          {/* Agent-surface anchors: the agent addresses every section by
              `section-<id>` regardless of which one is shown. */}
          <div className="hidden">
            {visibleSections.map((section) => (
              <SettingsSectionSurfaceAnchor
                key={section.id}
                section={section}
                label={settingsSectionLabel(section, t)}
                onSelect={openSection}
              />
            ))}
          </div>
          <div className="min-w-0 flex-1 pb-32">
            {activeSectionDef ? (
              <SettingsSectionContent section={activeSectionDef} t={t} />
            ) : (
              <SettingsHubEmptyState t={t} />
            )}
          </div>
        </div>
      </ContentLayout>
    </ShellViewAgentSurface>
  );
}

/**
 * The hub's resting state (no section chosen). The doctrine drops the old
 * grouped list — the top-bar section nav IS the picker now — so the body
 * teaches the interface rather than restating the nav: a quiet prompt to choose
 * a section above. Deterministic empty state per the design system.
 */
function SettingsHubEmptyState({ t }: { t: Translate }) {
  return (
    <div
      data-testid="settings-hub-empty"
      className="flex min-h-[12rem] flex-col items-start justify-center gap-1"
    >
      <p className="text-sm font-medium text-txt-strong">
        {t("settings.hubEmptyTitle", { defaultValue: "Choose a setting" })}
      </p>
      <p className="max-w-prose text-sm text-muted">
        {t("settings.hubEmptyBody", {
          defaultValue:
            "Pick a section from the bar above to configure your agent, system, or security.",
        })}
      </p>
    </div>
  );
}
