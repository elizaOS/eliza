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
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useAgentElement } from "../../agent-surface";
import { isManagedCloudRuntime } from "../../cloud/managed-cloud-runtime";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { ContentLayout } from "../../layouts/content-layout";
import { cn } from "../../lib/utils";
import { getWindowNavigationPath } from "../../navigation";
import { isAndroidCloudBuild } from "../../platform/android-runtime";
import { useAppSelector, useAppSelectorShallow } from "../../state";
import { useEnabledViewKinds } from "../../state/useViewKinds";
import { PermissionPrimingModal } from "../permissions/PermissionPrimingModal";
import { DesktopSettingsNavigation } from "../settings/DesktopSettingsNavigation";
import { SettingsHubList } from "../settings/SettingsHubList";
import {
  backFromConnectorDetail,
  type GroupedSettingsSections,
  getAllSettingsSections,
  getSettingsSectionRegistryVersion,
  groupSettingsSections,
  parseSettingsHash,
  readSettingsHashRoute,
  readSettingsHashSection,
  replaceConnectorDetailHash,
  replaceSettingsHash,
  type SettingsRoute,
  type SettingsSectionDef,
  settingsSectionLabel,
  settingsSectionTitle,
  subscribeSettingsSections,
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
 * Loading placeholder for a lazily-loaded section body (#11351). The skeleton
 * mirrors the title and settings-row rhythm while the accessible status names
 * the section being loaded.
 */
function SettingsSectionLoading({ title }: { title: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={`Loading ${title}`}
      className="min-h-24 space-y-3 py-1"
      role="status"
    >
      <span className="sr-only">Loading {title}</span>
      <div className="h-4 w-2/5 animate-pulse rounded-sm bg-bg-muted motion-reduce:animate-none" />
      <div className="h-11 w-full animate-pulse rounded-sm bg-bg-muted motion-reduce:animate-none" />
      <div className="h-11 w-full animate-pulse rounded-sm bg-bg-muted motion-reduce:animate-none" />
    </div>
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
            split stable with a section-shaped, accessible loading state. */}
        <Suspense fallback={<SettingsSectionLoading title={title} />}>
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
  const plugins = useAppSelector((s) => s.plugins);
  const runtimeTarget = useAppSelector((s) => s.startupCoordinator.target);
  const managedCloudRuntime = isManagedCloudRuntime(runtimeTarget);
  const enabledKinds = useEnabledViewKinds();
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const settingsRegistryVersion = useSyncExternalStore(
    subscribeSettingsSections,
    getSettingsSectionRegistryVersion,
    getSettingsSectionRegistryVersion,
  );
  const [activeSection, setActiveSection] = useState<string | null>(
    () => initialSection ?? readSettingsHashSection(),
  );
  const [settingsRoute, setSettingsRoute] = useState<SettingsRoute>(() =>
    readSettingsHashRoute(),
  );
  const [primePermission, setPrimePermission] = useState<PermissionId | null>(
    null,
  );

  const eligibleSections = useMemo(() => {
    // The version is an invalidation input; the registry read below returns
    // the actual section definitions after a host/plugin mutation.
    void settingsRegistryVersion;
    return getAllSettingsSections().filter(
      (section) => !section.cloudOnly || managedCloudRuntime,
    );
  }, [managedCloudRuntime, settingsRegistryVersion]);
  const eligibleSectionIds = useMemo(
    () => new Set(eligibleSections.map((section) => section.id)),
    [eligibleSections],
  );
  const visibleSections = useMemo(() => {
    return eligibleSections.filter((section) => {
      if (section.id === "wallet-rpc" && walletEnabled === false) return false;
      if (!isViewVisible(section, enabledKinds)) return false;
      if (section.hideOnCloud && isAndroidCloudBuild()) return false;
      return true;
    });
  }, [eligibleSections, walletEnabled, enabledKinds]);
  const grouped: GroupedSettingsSections = useMemo(
    () => groupSettingsSections(visibleSections),
    [visibleSections],
  );

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  // Legacy path deep links: /connectors, /connectors/<id>, /settings/connectors/<id>
  // → structured hash the connectors body already understands.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const path = getWindowNavigationPath();
    const connectorsPath = path.match(
      /^\/(?:settings\/)?connectors(?:\/([a-z0-9-]+))?\/?$/i,
    );
    if (!connectorsPath) return;
    const connectorId = connectorsPath[1]?.toLowerCase();
    if (connectorId) {
      setActiveSection("connectors");
      replaceConnectorDetailHash(connectorId === "twitter" ? "x" : connectorId);
      setSettingsRoute({
        kind: "connector-detail",
        sectionId: "connectors",
        connectorId: connectorId === "twitter" ? "x" : connectorId,
      });
    } else {
      // Index case: the path alone identifies the section — writing
      // `#connectors` here would leave `/connectors#connectors` in the URL bar
      // and break canonical-URL expectations. React state carries the section.
      setActiveSection("connectors");
      setSettingsRoute({ kind: "section", sectionId: "connectors" });
      return;
    }
    window.dispatchEvent(new Event("popstate"));
  }, []);

  const openSection = useCallback((sectionId: string) => {
    setActiveSection(sectionId);
    replaceSettingsHash(sectionId);
    setSettingsRoute({ kind: "section", sectionId });
  }, []);

  const backToHub = useCallback(() => {
    setActiveSection(null);
    setSettingsRoute({ kind: "hub" });
    if (typeof window !== "undefined") {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }
  }, []);

  const backToConnectorsIndex = useCallback(() => {
    backFromConnectorDetail();
  }, []);

  useEffect(() => {
    if (!initialSection) return;
    // initialSection may be a nested connectors route (`connectors/discord`)
    // from deep links / focus events — parse before treating it as a flat id.
    const route = parseSettingsHash(initialSection);
    if (route.kind === "connector-detail") {
      setActiveSection("connectors");
      setSettingsRoute(route);
      replaceConnectorDetailHash(route.connectorId);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("popstate"));
      }
      return;
    }
    if (route.kind === "section") {
      openSection(route.sectionId);
    }
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
    const handleLocationChange = () => {
      const route = readSettingsHashRoute();
      setSettingsRoute(route);
      const nextSection = readSettingsHashSection();
      if (nextSection && eligibleSectionIds.has(nextSection)) {
        setActiveSection(nextSection);
      } else {
        setActiveSection(null);
      }
    };
    window.addEventListener("hashchange", handleLocationChange);
    window.addEventListener("popstate", handleLocationChange);
    return () => {
      window.removeEventListener("hashchange", handleLocationChange);
      window.removeEventListener("popstate", handleLocationChange);
    };
  }, [eligibleSectionIds]);

  // Hosts may register sections after Settings mounts (for example, the web
  // shell dynamically imports private Cloud surfaces). Reconcile a retained
  // deep-link as soon as its section becomes available; an unknown hash stays
  // on the hub until some owner actually registers that id.
  useEffect(() => {
    void settingsRegistryVersion;
    if (typeof window === "undefined") return;
    const nextSection = readSettingsHashSection();
    if (!nextSection) return;
    if (!eligibleSectionIds.has(nextSection)) {
      setActiveSection(null);
      return;
    }
    setSettingsRoute(readSettingsHashRoute());
    setActiveSection(nextSection);
  }, [eligibleSectionIds, settingsRegistryVersion]);

  // Explicit navigation (hash / initialSection / agent anchor) resolves
  // against the runtime-eligible registry, not just the visible hub rows:
  // hidden sections stay registered exactly so their deep-links keep working
  // (the mvp-hidden contract), while Cloud controls remain unavailable to
  // local and VPS runtimes. The hub itself only lists visible sections.
  const activeSectionDef: SettingsSectionDef | null = activeSection
    ? (visibleSections.find((section) => section.id === activeSection) ??
      eligibleSections.find((section) => section.id === activeSection) ??
      null)
    : null;
  // A desktop workspace always has useful content beside its persistent rail.
  // This presentational default does not write a hash, so the mobile root still
  // opens on the exact same hub when the viewport becomes narrow.
  const desktopSectionDef = activeSectionDef ?? visibleSections[0] ?? null;
  const displayedSectionDef = isDesktop ? desktopSectionDef : activeSectionDef;

  // Mobile keeps the uniform top bar: the hub shows "Settings" and a section
  // shows its title with a back action. Connector detail is one level deeper
  // (detail → connectors index → settings hub → launcher).
  const settingsTitle = t("nav.settings", { defaultValue: "Settings" });
  const connectorDetailId =
    settingsRoute.kind === "connector-detail"
      ? settingsRoute.connectorId
      : null;
  const connectorDetailName = connectorDetailId
    ? (plugins.find((p) => p.id === connectorDetailId)?.name ??
      connectorDetailId)
    : null;
  const headerTitle = connectorDetailName
    ? connectorDetailName
    : activeSectionDef
      ? settingsSectionTitle(activeSectionDef, t)
      : settingsTitle;
  const onBack = connectorDetailId
    ? backToConnectorsIndex
    : activeSectionDef
      ? backToHub
      : navigateBackToLauncher;
  const backLabel = connectorDetailId
    ? "Back to Connectors"
    : activeSectionDef
      ? "Back to Settings"
      : "Back to launcher";
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
