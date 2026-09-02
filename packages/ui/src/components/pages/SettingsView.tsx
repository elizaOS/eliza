/**
 * The Settings view (`/settings`) adapts its information architecture to the
 * available workspace. Web and desktop surfaces use the persistent grouped
 * settings workspace from 700px upward; native iOS/Android surfaces preserve
 * the familiar hub → subview flow at every viewport width.
 *
 * Section content is lazy-loaded and filtered by declarative host capabilities
 * plus normal product visibility; `initialSection` deep-links a specific
 * section. Also reusable in modal form (`inModal`).
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
import { getBootConfig } from "../../config/boot-config-store";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { ContentLayout } from "../../layouts/content-layout";
import { cn } from "../../lib/utils";
import { getWindowNavigationPath } from "../../navigation";
import { isAndroidCloudBuild } from "../../platform/android-runtime";
import { getFrontendPlatform } from "../../platform/platform-guards";
import { useAppSelector, useAppSelectorShallow } from "../../state";
import { useEnabledViewKinds } from "../../state/useViewKinds";
import { PagePanel } from "../composites/page-panel";
import { PermissionPrimingModal } from "../permissions/PermissionPrimingModal";
import { resolvePrimingSet } from "../permissions/permission-priming";
import { DesktopSettingsNavigation } from "../settings/DesktopSettingsNavigation";
import { SettingsHubList } from "../settings/SettingsHubList";
import {
  resolveSettingsExperience,
  settingsSectionMatchesExperience,
} from "../settings/settings-experience";
import { buildSettingsNavigationGroups } from "../settings/settings-navigation-model";
import {
  resolveSettingsRuntimeCapabilities,
  type SettingsRuntimeCapabilities,
  settingsRuntimeHasCapability,
} from "../settings/settings-runtime-capabilities";
import {
  getSettingsSectionRegistryVersion,
  settingsSectionIsAvailable,
  subscribeSettingsSections,
} from "../settings/settings-section-registry";
import {
  backFromConnectorDetail,
  type GroupedSettingsSections,
  getAllSettingsSections,
  groupSettingsSections,
  parseSettingsHash,
  readSettingsHashRoute,
  readSettingsHashSection,
  replaceConnectorDetailHash,
  replaceSettingsHash,
  replaceSettingsHashRoute,
  type SettingsRoute,
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
  compactInset = false,
}: {
  section: SettingsSectionDef;
  t: Translate;
  // Whether this body carries the `#<section.id>` deep-link/anchor DOM id.
  // Desktop wraps the section title header + body in one anchored container so
  // the section's accessible title lives inside `#<section.id>`, and passes
  // `false` here to keep that id unique. Mobile/modal render the body alone and
  // keep the anchor on it (default).
  anchored?: boolean;
  /** Keep compact detail cards on the same 16px content rail as the hub. */
  compactInset?: boolean;
}) {
  const Component = section.Component;
  const title = settingsSectionTitle(section, t);
  return (
    <div
      id={anchored ? section.id : undefined}
      data-slot="settings-section-content"
      className={cn(section.bodyClassName, compactInset && "!px-4")}
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
        variant="outlineAccent"
        size="regularCompact"
        onClick={onRetry}
        className="mt-1"
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
    <Button
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
  runtimeCapabilities: injectedRuntimeCapabilities,
}: {
  inModal?: boolean;
  onClose?: () => void;
  initialSection?: string;
  navigatePayload?: unknown;
  navigateSequence?: number;
  /** Deterministic host-capability override for embedders and tests. */
  runtimeCapabilities?: SettingsRuntimeCapabilities;
} = {}) {
  const { t, loadPlugins, walletEnabled } = useAppSelectorShallow((s) => ({
    t: s.t,
    loadPlugins: s.loadPlugins,
    walletEnabled: s.walletEnabled,
  }));
  const plugins = useAppSelector((s) => s.plugins);
  const runtimeTarget = useAppSelector((s) => s.startupCoordinator.target);
  const cloudOnlyBranding = getBootConfig().branding.cloudOnly === true;
  const managedCloudRuntime =
    isManagedCloudRuntime(runtimeTarget) || cloudOnlyBranding;
  const settingsExperience = resolveSettingsExperience(managedCloudRuntime);
  const enabledKinds = useEnabledViewKinds();
  const frontendPlatform = getFrontendPlatform();
  const androidCloudBuild = isAndroidCloudBuild();
  const isNativeCompactSettings =
    frontendPlatform === "ios" || frontendPlatform === "android";
  const isWideSettingsViewport = useMediaQuery("(min-width: 700px)");
  const isWideSettings = isWideSettingsViewport && !isNativeCompactSettings;
  const runtimeCapabilities = useMemo(
    () => injectedRuntimeCapabilities ?? resolveSettingsRuntimeCapabilities(),
    [injectedRuntimeCapabilities],
  );
  const detachedSettingsShell =
    !inModal &&
    settingsRuntimeHasCapability(
      runtimeCapabilities,
      "detached-settings-shell",
    );
  const registryVersion = useSyncExternalStore(
    subscribeSettingsSections,
    getSettingsSectionRegistryVersion,
    getSettingsSectionRegistryVersion,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the registry version is the external-store invalidation token for this list snapshot.
  const allSections = useMemo(
    () => getAllSettingsSections(),
    [registryVersion],
  );
  const availableSections = useMemo(
    () =>
      allSections.filter(
        (section) =>
          (!section.androidCloudOnly || androidCloudBuild) &&
          settingsSectionIsAvailable(section, runtimeCapabilities),
      ),
    [allSections, androidCloudBuild, runtimeCapabilities],
  );
  const availableSectionIds = useMemo(
    () => new Set(availableSections.map((section) => section.id)),
    [availableSections],
  );
  const [activeSection, setActiveSection] = useState<string | null>(() => {
    const requested = initialSection ?? readSettingsHashSection();
    return requested && availableSectionIds.has(requested) ? requested : null;
  });
  const [settingsRoute, setSettingsRoute] = useState<SettingsRoute>(() =>
    readSettingsHashRoute(),
  );
  const [primePermission, setPrimePermission] = useState<PermissionId | null>(
    null,
  );

  const visibleSections = useMemo(
    () =>
      availableSections.filter((section) => {
        if (section.id === "wallet-rpc" && walletEnabled === false)
          return false;
        if (!settingsSectionMatchesExperience(section, settingsExperience)) {
          return false;
        }
        if (!isViewVisible(section, enabledKinds)) return false;
        if (section.hideOnCloud && androidCloudBuild) return false;
        return true;
      }),
    [
      androidCloudBuild,
      availableSections,
      enabledKinds,
      settingsExperience,
      walletEnabled,
    ],
  );
  const visibleSectionIds = useMemo(
    () => new Set(visibleSections.map((section) => section.id)),
    [visibleSections],
  );
  const grouped: GroupedSettingsSections =
    groupSettingsSections(visibleSections);
  const navigationGrouped = buildSettingsNavigationGroups(
    grouped,
    activeSection,
  );

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  // Legacy path deep links: /connectors, /connectors/<id>, /settings/connectors/<id>
  // → structured hash the connectors body already understands.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!availableSectionIds.has("connectors")) return;
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
  }, [availableSectionIds]);

  const openSection = useCallback(
    (sectionId: string) => {
      if (!availableSectionIds.has(sectionId)) {
        setActiveSection(null);
        setSettingsRoute({ kind: "hub" });
        replaceSettingsHashRoute({ kind: "hub" });
        return;
      }
      setActiveSection(sectionId);
      replaceSettingsHash(sectionId);
      setSettingsRoute({ kind: "section", sectionId });
    },
    [availableSectionIds],
  );

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
      if (!availableSectionIds.has("connectors")) {
        openSection("connectors");
        return;
      }
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
  }, [availableSectionIds, initialSection, openSection]);

  useEffect(() => {
    const permission = readSettingsPermissionRequest(navigatePayload);
    if (!permission) {
      if (navigateSequence > 0) setPrimePermission(null);
      return;
    }
    const [supportedPermission] = resolvePrimingSet({ only: [permission] });
    setPrimePermission(supportedPermission ?? null);
  }, [navigatePayload, navigateSequence]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleLocationChange = () => {
      const route = readSettingsHashRoute();
      setSettingsRoute(route);
      const nextSection = readSettingsHashSection();
      if (
        nextSection &&
        (visibleSectionIds.has(nextSection) ||
          availableSectionIds.has(nextSection))
      ) {
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
  }, [availableSectionIds, visibleSectionIds]);

  // Capability requirements are hard availability boundaries, unlike
  // developer/preview visibility. An unavailable deep link must never mount a
  // desktop bridge section on a portable runtime.
  useEffect(() => {
    const requestedSection =
      settingsRoute.kind === "hub" ? null : settingsRoute.sectionId;
    if (
      (!activeSection || availableSectionIds.has(activeSection)) &&
      (!requestedSection || availableSectionIds.has(requestedSection))
    ) {
      return;
    }
    setActiveSection(null);
    setSettingsRoute({ kind: "hub" });
    replaceSettingsHashRoute({ kind: "hub" });
  }, [activeSection, availableSectionIds, settingsRoute]);

  // Explicit navigation (hash / initialSection / agent anchor) resolves
  // against the capability-eligible registry, not just the visible hub rows:
  // hidden sections stay registered so their deep-links keep working (the
  // mvp-hidden contract), while unavailable native modules and Android Cloud
  // account controls remain hard stops. The hub itself only lists visible
  // sections.
  const activeSectionDef: SettingsSectionDef | null = activeSection
    ? (visibleSections.find((section) => section.id === activeSection) ??
      availableSections.find((section) => section.id === activeSection) ??
      null)
    : null;
  // A desktop workspace always has useful content beside its persistent rail.
  // This presentational default does not write a hash, so the mobile root still
  // opens on the exact same hub when the viewport becomes narrow.
  const desktopSectionDef =
    activeSectionDef ?? navigationGrouped[0]?.items[0] ?? null;
  const displayedSectionDef = isWideSettings
    ? desktopSectionDef
    : activeSectionDef;

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
  const desktopSidebar = isWideSettings ? (
    <DesktopSettingsNavigation
      grouped={navigationGrouped}
      activeId={desktopSectionDef?.id ?? null}
      onSelect={openSection}
      onBack={detachedSettingsShell ? undefined : navigateBackToLauncher}
      settingsLabel={settingsTitle}
      label={(labelKey, fallback) => t(labelKey, { defaultValue: fallback })}
    />
  ) : null;

  return (
    <ShellViewAgentSurface viewId="settings">
      {detachedSettingsShell ? (
        <div
          aria-hidden="true"
          className="settings-window-drag-strip"
          data-window-titlebar="true"
        />
      ) : null}
      <ContentLayout
        inModal={inModal}
        className={cn(
          "settings-surface settings-canvas",
          !inModal && !isWideSettings && "min-h-0",
          detachedSettingsShell && "pt-8",
        )}
        contentClassName="!overflow-hidden !px-0 !pb-0 !pt-0"
      >
        <div
          data-testid="settings-shell"
          data-settings-presentation={
            isNativeCompactSettings ? "compact-native" : "workspace"
          }
          className={cn(
            "flex h-full min-h-0 w-full overflow-hidden",
            isWideSettings ? "flex-row" : "flex-col",
          )}
        >
          {desktopSidebar}
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

          {!isWideSettings ? (
            <div
              className={cn(
                isNativeCompactSettings &&
                  "pt-[max(calc(var(--safe-area-top,0px)-2rem),0.75rem)]",
              )}
            >
              <ViewHeader
                title={headerTitle}
                onBack={onBack}
                backLabel={backLabel}
                showBack={Boolean(activeSectionDef) || !detachedSettingsShell}
                className="px-1.5 sm:px-1.5"
              />
            </div>
          ) : null}

          <div
            data-scroll-cert-scroller={!isWideSettings ? "" : undefined}
            data-testid="settings-scroll-region"
            className={cn(
              "min-w-0 flex-1",
              isWideSettings
                ? "settings-dotted-canvas eliza-chat-scroll min-h-0 overflow-y-auto"
                : "settings-canvas eliza-chat-scroll min-h-0 overflow-y-auto",
            )}
          >
            {isWideSettings ? (
              <PagePanel.ContentRail
                data-testid="desktop-settings-work-area"
                width="compact"
                className="pb-12 pt-12"
              >
                {desktopSectionDef ? (
                  // The `#<section.id>` anchor wraps the title header + body so
                  // the section's accessible title (the h1) lives inside the
                  // section's deep-link anchor, not as a detached sibling above
                  // it. Header stays outside `bodyClassName` padding, so this is
                  // structural only. The active rail row provides visual
                  // context; the h1 remains available to assistive technology.
                  <section
                    id={desktopSectionDef.id}
                    aria-labelledby={`settings-section-title-${desktopSectionDef.id}`}
                  >
                    <h1
                      id={`settings-section-title-${desktopSectionDef.id}`}
                      className="sr-only"
                    >
                      {settingsSectionTitle(desktopSectionDef, t)}
                    </h1>
                    <SettingsSectionContent
                      section={desktopSectionDef}
                      t={t}
                      anchored={false}
                    />
                  </section>
                ) : null}
              </PagePanel.ContentRail>
            ) : activeSectionDef ? (
              <SettingsSectionContent
                section={activeSectionDef}
                t={t}
                compactInset
              />
            ) : (
              /* The hub IS the mobile main screen. Tapping a row swaps in
                 the section subview; the shared header returns here. */
              <SettingsHubList
                grouped={navigationGrouped}
                onSelect={openSection}
                label={(labelKey, fallback) =>
                  t(labelKey, { defaultValue: fallback })
                }
              />
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
