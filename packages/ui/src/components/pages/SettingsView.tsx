/**
 * The Settings view (`/settings`) adapts its information architecture to the
 * available workspace. At 1024px and wider it renders a persistent grouped
 * settings rail beside the active section. On narrower screens it preserves the
 * existing iOS/Android-style hub → subview flow and shared back header.
 *
 * Section content is lazy-loaded and gated by `isViewVisible`; `initialSection`
 * deep-links a specific section. Also reusable in modal form (`inModal`).
 */
import { isViewVisible } from "@elizaos/core";
import { isPermissionId, type PermissionId } from "@elizaos/shared";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { ContentLayout } from "../../layouts/content-layout";
import { cn } from "../../lib/utils";
import { isAndroidCloudBuild } from "../../platform/android-runtime";
import { useAppSelectorShallow } from "../../state";
import { useEnabledViewKinds } from "../../state/useViewKinds";
import { PermissionPrimingModal } from "../permissions/PermissionPrimingModal";
import { DesktopSettingsNavigation } from "../settings/DesktopSettingsNavigation";
import { SettingsHubList } from "../settings/SettingsHubList";
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

function readSettingsPermissionRequest(payload: unknown): PermissionId | null {
  if (!payload || typeof payload !== "object") return null;
  const permissionRequest = (payload as { permissionRequest?: unknown })
    .permissionRequest;
  if (!permissionRequest || typeof permissionRequest !== "object") {
    return null;
  }
  const permission = (permissionRequest as { permission?: unknown }).permission;
  return isPermissionId(permission) && permission !== "shell"
    ? permission
    : null;
}

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
  anchored = true,
}: {
  section: SettingsSectionDef;
  t: Translate;
  // Whether this body carries the `#<section.id>` deep-link/anchor DOM id.
  // Desktop wraps the section title header + body in one anchored container so
  // the section's accessible title lives inside `#<section.id>`, and passes
  // `false` here to keep that id unique. Mobile/modal render the body alone and
  // keep the anchor on it (default).
  anchored?: boolean;
}) {
  const Component = section.Component;
  const title = settingsSectionTitle(section, t);
  return (
    <div
      id={anchored ? section.id : undefined}
      className={section.bodyClassName}
    >
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
  active,
  onSelect,
}: {
  section: SettingsSectionDef;
  label: string;
  /** Whether this is the currently-shown section. */
  active: boolean;
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
      /* #13889/#13590: the agent-addressable anchor carries `data-agent-id`; the
         "which section is current" signal must live on the SAME element so the
         `[data-agent-id^="section-"][aria-current="page"]` contract (agent
         surface + packaged regression lane) resolves. #13590's SectionNav
         refactor split these apart. Set after the spread so it always wins. */
      aria-current={active ? "page" : undefined}
    />
  );
}

export function SettingsView({
  inModal,
  initialSection,
  navigatePayload,
  navigateSequence = 0,
}: {
  inModal?: boolean;
  onClose?: () => void;
  initialSection?: string;
  navigatePayload?: unknown;
  navigateSequence?: number;
} = {}) {
  const { t, loadPlugins, walletEnabled } = useAppSelectorShallow((s) => ({
    t: s.t,
    loadPlugins: s.loadPlugins,
    walletEnabled: s.walletEnabled,
  }));
  const enabledKinds = useEnabledViewKinds();
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [activeSection, setActiveSection] = useState<string | null>(
    () => initialSection ?? readSettingsHashSection(),
  );
  const [primePermission, setPrimePermission] = useState<PermissionId | null>(
    null,
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
    const permission = readSettingsPermissionRequest(navigatePayload);
    if (!permission) {
      if (navigateSequence > 0) setPrimePermission(null);
      return;
    }
    setPrimePermission(permission);
  }, [navigatePayload, navigateSequence]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleHashChange = () => {
      const nextSection = readSettingsHashSection();
      if (
        nextSection &&
        (visibleSectionIds.has(nextSection) ||
          getAllSettingsSections().some((s) => s.id === nextSection))
      ) {
        setActiveSection(nextSection);
      } else {
        setActiveSection(null);
      }
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [visibleSectionIds]);

  // Explicit navigation (hash / initialSection / agent anchor) resolves
  // against the full registry, not just the visible hub rows: hidden sections
  // stay registered exactly so their deep-links keep working (the mvp-hidden
  // contract). The hub itself only lists visible sections.
  const activeSectionDef: SettingsSectionDef | null = activeSection
    ? (visibleSections.find((section) => section.id === activeSection) ??
      getAllSettingsSections().find(
        (section) => section.id === activeSection,
      ) ??
      null)
    : null;
  // A desktop workspace always has useful content beside its persistent rail.
  // This presentational default does not write a hash, so the mobile root still
  // opens on the exact same hub when the viewport becomes narrow.
  const desktopSectionDef = activeSectionDef ?? visibleSections[0] ?? null;
  const displayedSectionDef = isDesktop ? desktopSectionDef : activeSectionDef;

  // Mobile keeps the uniform top bar: the hub shows "Settings" and a section
  // shows its title with a back action. Desktop uses an in-pane title instead.
  const settingsTitle = t("nav.settings", { defaultValue: "Settings" });
  const headerTitle = activeSectionDef
    ? settingsSectionTitle(activeSectionDef, t)
    : settingsTitle;
  const onBack = activeSectionDef ? backToHub : navigateBackToLauncher;
  const backLabel = activeSectionDef ? "Back to Settings" : "Back to launcher";
  const desktopSidebar = isDesktop ? (
    <DesktopSettingsNavigation
      grouped={grouped}
      activeId={desktopSectionDef?.id ?? null}
      onSelect={openSection}
      onBack={navigateBackToLauncher}
      settingsLabel={settingsTitle}
      label={(labelKey, fallback) => t(labelKey, { defaultValue: fallback })}
    />
  ) : null;

  return (
    <ShellViewAgentSurface viewId="settings">
      <ContentLayout
        inModal={inModal}
        contentClassName={isDesktop ? "px-0 pt-0" : "max-sm:pt-1"}
        sidebar={desktopSidebar}
        sidebarCollapsible={false}
      >
        <div
          data-testid="settings-shell"
          className={cn(
            "flex min-h-full w-full",
            isDesktop ? "flex-row" : "flex-col",
          )}
        >
          {/* Agent-surface anchors: the agent addresses every section by
              `section-<id>` regardless of which one is shown. */}
          <div className="hidden">
            {visibleSections.map((section) => (
              <SettingsSectionSurfaceAnchor
                key={section.id}
                section={section}
                label={settingsSectionLabel(section, t)}
                active={section.id === displayedSectionDef?.id}
                onSelect={openSection}
              />
            ))}
          </div>

          <div className="min-w-0 flex-1 pb-32">
            {isDesktop ? (
              <main
                data-testid="desktop-settings-work-area"
                className="mx-auto w-full max-w-[90rem] px-6 pb-10 pt-6 xl:px-8 xl:pt-8"
              >
                {desktopSectionDef ? (
                  // The `#<section.id>` anchor wraps the title header + body so
                  // the section's accessible title (the h1) lives inside the
                  // section's deep-link anchor, not as a detached sibling above
                  // it. Header stays outside `bodyClassName` padding, so this is
                  // structural only — no visual change.
                  <div id={desktopSectionDef.id}>
                    <header className="mb-8 border-b border-border/60 pb-5">
                      <p className="text-xs font-medium text-muted">
                        {settingsTitle}
                      </p>
                      <h1 className="mt-1 text-xl font-semibold tracking-tight text-txt-strong">
                        {settingsSectionTitle(desktopSectionDef, t)}
                      </h1>
                    </header>
                    <SettingsSectionContent
                      section={desktopSectionDef}
                      t={t}
                      anchored={false}
                    />
                  </div>
                ) : null}
              </main>
            ) : (
              <>
                <ViewHeader
                  title={headerTitle}
                  onBack={onBack}
                  backLabel={backLabel}
                  className="px-0"
                />
                {activeSectionDef ? (
                  <SettingsSectionContent section={activeSectionDef} t={t} />
                ) : (
                  /* The hub IS the mobile main screen. Tapping a row swaps in
                     the section subview; the shared header returns here. */
                  <SettingsHubList
                    grouped={grouped}
                    onSelect={openSection}
                    label={(labelKey, fallback) =>
                      t(labelKey, { defaultValue: fallback })
                    }
                  />
                )}
              </>
            )}
          </div>
          {primePermission ? (
            <PermissionPrimingModal
              ids={[primePermission]}
              open
              onComplete={() => setPrimePermission(null)}
            />
          ) : null}
        </div>
      </ContentLayout>
    </ShellViewAgentSurface>
  );
}
