import { Capacitor } from "@capacitor/core";
import { Button } from "@elizaos/ui";
import { ChevronRight, ListTodo, Settings } from "lucide-react";
import type {
  CSSProperties,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import { MOBILE_RUNTIME_MODE_CHANGED_EVENT } from "../../events";
import { useMediaQuery } from "../../hooks";
import {
  type DynamicNavTab,
  getTabGroups,
  isAppsToolTab,
  type TabGroup,
  titleForTab,
} from "../../navigation";
import { readPersistedMobileRuntimeMode } from "../../onboarding/mobile-runtime-mode";
import {
  isDetachedWindowShell,
  resolveWindowShellRoute,
} from "../../platform/window-shell";
import { useApp } from "../../state";
import { useIsDeveloperMode } from "../../state/useDeveloperMode";
import { getOverlayApp } from "../apps/overlay-app-registry";
import { CloudStatusBadge } from "../cloud/CloudStatusBadge";
import {
  CompanionInferenceAlertButton as InferenceCloudAlertButton,
  resolveCompanionInferenceNotice,
} from "../companion/injected";
import { LanguageDropdown } from "../shared/LanguageDropdown";
import { ThemeToggle } from "../shared/ThemeToggle";
import { HEADER_BUTTON_STYLE } from "./ShellHeaderControls";

const MOBILE_HEADER_MEDIA_QUERY = "(max-width: 819px)";
const DESKTOP_LABEL_COLLAPSE_MEDIA_QUERY = "(max-width: 1380px)";

const NAV_LABEL_I18N_KEY: Record<string, string> = {
  Apps: "nav.apps",
  Automations: "nav.automations",
  Browser: "nav.browser",
  Character: "nav.character",
  Chat: "nav.chat",
  Companion: "nav.companion",
  Connectors: "nav.social",
  Heartbeats: "nav.heartbeats",
  Knowledge: "nav.documents",
  LifeOps: "nav.lifeops",
  Settings: "nav.settings",
  Stream: "nav.stream",
  Wallet: "nav.wallet",
};

const NAV_DESCRIPTION_I18N_KEY: Record<string, string> = {
  Apps: "nav.description.apps",
  Automations: "nav.description.automations",
  Browser: "nav.description.browser",
  Character: "nav.description.character",
  Chat: "nav.description.chat",
  Settings: "nav.description.settings",
  Stream: "nav.description.stream",
  Wallet: "nav.description.wallet",
};

const TOPBAR_NAV_BUTTON_CLASSNAME =
  "group relative inline-flex h-[2.375rem] min-h-[2.375rem] shrink-0 items-center gap-2 rounded-md border border-transparent px-2.5 text-xs font-medium text-muted transition-colors duration-150 hover:text-txt after:absolute after:inset-x-2.5 after:bottom-0 after:h-[3px] after:rounded-t-full after:bg-accent/70 after:opacity-0 after:transition-opacity after:duration-150 hover:after:opacity-55";
const TOPBAR_NAV_BUTTON_ACTIVE_CLASSNAME = "text-accent after:opacity-100";
const TOPBAR_ICON_BUTTON_CLASSNAME =
  "relative inline-flex h-[2.375rem] w-[2.375rem] min-h-[2.375rem] min-w-[2.375rem] shrink-0 items-center justify-center rounded-md border border-transparent bg-transparent text-muted transition-colors duration-150 hover:text-txt after:absolute after:inset-x-2 after:bottom-0 after:h-[3px] after:rounded-t-full after:bg-accent/70 after:opacity-0 after:transition-opacity after:duration-150 hover:after:opacity-55";
const TOPBAR_ICON_BUTTON_ACTIVE_CLASSNAME = "text-accent after:opacity-100";
const TOPBAR_RIGHT_ICON_BUTTON_CLASSNAME =
  "inline-flex h-[2.375rem] w-[2.375rem] min-h-[2.375rem] min-w-[2.375rem] shrink-0 items-center justify-center rounded-md border border-transparent !bg-transparent text-muted shadow-none ring-0 transition-colors duration-150 hover:!bg-transparent hover:text-txt active:!bg-transparent data-[state=open]:!bg-transparent";
const TOPBAR_RIGHT_ICON_BUTTON_ACTIVE_CLASSNAME = "text-accent";
const MOBILE_BOTTOM_NAV_BUTTON_CLASSNAME =
  "group relative mx-auto inline-flex h-11 w-full max-w-12 min-w-0 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:text-txt after:absolute after:inset-x-2 after:top-0 after:h-[2px] after:rounded-b-full after:bg-accent/70 after:opacity-0 after:transition-opacity after:duration-150";
const MOBILE_BOTTOM_NAV_BUTTON_ACTIVE_CLASSNAME =
  "text-accent after:opacity-100";
const MAC_TITLEBAR_PADDING_STYLE: CSSProperties = {
  paddingInlineStart:
    "max(env(safe-area-inset-left, 0px), var(--eliza-macos-frame-left-inset, 80px))",
  paddingInlineEnd: "0.75rem",
  paddingTop:
    "max(env(safe-area-inset-top, 0px), var(--eliza-macos-frame-top-inset, 0px))",
};

interface HeaderProps {
  mobileLeft?: ReactNode;
  pageRightExtras?: ReactNode;
  transparent?: boolean;
  hideCloudCredits?: boolean;
  tasksEventsPanelOpen?: boolean;
  onToggleTasksPanel?: () => void;
}

function shouldShowMacDesktopTitleBar(): boolean {
  if (!isElectrobunRuntime()) return false;
  if (typeof navigator === "undefined") return false;
  if (!/Mac/i.test(navigator.userAgent)) return false;
  if (/(iPhone|iPad|iPod)/i.test(navigator.userAgent)) return false;

  const route = resolveWindowShellRoute();
  return !isDetachedWindowShell(route);
}

export function Header({
  mobileLeft,
  pageRightExtras,
  transparent: _transparent = false,
  hideCloudCredits = false,
  tasksEventsPanelOpen = false,
  onToggleTasksPanel,
}: HeaderProps) {
  const {
    activeGameRunId,
    activeOverlayApp,
    appRuns,
    browserEnabled,
    chatLastUsage,
    conversationMessages,
    elizaCloudAuthRejected,
    elizaCloudConnected,
    elizaCloudCredits,
    elizaCloudCreditsCritical,
    elizaCloudCreditsError,
    elizaCloudCreditsLow,
    elizaCloudEnabled,
    loadDropStatus,
    plugins,
    setState,
    setTab,
    setUiLanguage,
    setUiTheme,
    tab,
    t,
    uiLanguage,
    uiTheme,
    walletEnabled,
  } = useApp();

  const isMobileViewport = useMediaQuery(MOBILE_HEADER_MEDIA_QUERY);
  const [mobileRuntimeMode, setMobileRuntimeMode] = useState(
    readPersistedMobileRuntimeMode,
  );
  const collapseDesktopNavLabels = useMediaQuery(
    DESKTOP_LABEL_COLLAPSE_MEDIA_QUERY,
  );
  const showMacDesktopTitleBar = shouldShowMacDesktopTitleBar();
  const titlebarPaddingStyle = showMacDesktopTitleBar
    ? MAC_TITLEBAR_PADDING_STYLE
    : undefined;
  const showCloudStatus = !hideCloudCredits && !isMobileViewport;
  const stopHeaderPointerPropagation = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
    },
    [],
  );

  useEffect(() => {
    void loadDropStatus();
  }, [loadDropStatus]);

  useEffect(() => {
    setState("chatMode", "power");
  }, [setState]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const handleMobileRuntimeModeChanged = () => {
      setMobileRuntimeMode(readPersistedMobileRuntimeMode());
    };

    handleMobileRuntimeModeChanged();
    document.addEventListener(
      MOBILE_RUNTIME_MODE_CHANGED_EVENT,
      handleMobileRuntimeModeChanged,
    );

    return () => {
      document.removeEventListener(
        MOBILE_RUNTIME_MODE_CHANGED_EVENT,
        handleMobileRuntimeModeChanged,
      );
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    if (isMobileViewport) {
      document.documentElement.classList.add("eliza-mobile-bottom-nav");
    } else {
      document.documentElement.classList.remove("eliza-mobile-bottom-nav");
    }

    return () => {
      document.documentElement.classList.remove("eliza-mobile-bottom-nav");
    };
  }, [isMobileViewport]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const rootClassList = document.documentElement.classList;
    if (showMacDesktopTitleBar) {
      rootClassList.add(
        "eliza-electrobun-custom-titlebar",
        "eliza-electrobun-macos-titlebar",
      );
    } else {
      rootClassList.remove(
        "eliza-electrobun-custom-titlebar",
        "eliza-electrobun-macos-titlebar",
      );
    }

    return () => {
      rootClassList.remove("eliza-electrobun-custom-titlebar");
      if (!rootClassList.contains("eliza-electrobun-frameless")) {
        rootClassList.remove("eliza-electrobun-macos-titlebar");
      }
    };
  }, [showMacDesktopTitleBar]);

  const streamingEnabled = useMemo(
    () => plugins.some((plugin) => plugin.id === "streaming" && plugin.enabled),
    [plugins],
  );
  const developerModeEnabled = useIsDeveloperMode();

  // Plugin-contributed nav tabs from each loaded plugin's `app.navTabs`.
  // Filter out developer-only tabs unless Developer Mode is enabled.
  const dynamicNavTabs = useMemo<DynamicNavTab[]>(() => {
    const out: DynamicNavTab[] = [];
    for (const plugin of plugins) {
      if (!plugin.enabled) continue;
      const navTabs = plugin.app?.navTabs;
      if (!navTabs?.length) continue;
      const appDeveloperOnly = plugin.app?.developerOnly === true;
      for (const navTab of navTabs) {
        const isDeveloperOnly =
          appDeveloperOnly || navTab.developerOnly === true;
        if (isDeveloperOnly && !developerModeEnabled) continue;
        out.push({
          tabId: navTab.id,
          label: navTab.label,
          navGroup: navTab.group,
        });
      }
    }
    return out;
  }, [plugins, developerModeEnabled]);

  const hideMobileLocalAutomations =
    isMobileViewport &&
    mobileRuntimeMode === "local" &&
    Capacitor.isNativePlatform();

  const tabGroups = useMemo(
    () =>
      getTabGroups(
        streamingEnabled,
        walletEnabled,
        browserEnabled,
        dynamicNavTabs,
        undefined,
        !hideMobileLocalAutomations,
      ),
    [
      browserEnabled,
      hideMobileLocalAutomations,
      streamingEnabled,
      walletEnabled,
      dynamicNavTabs,
    ],
  );

  useEffect(() => {
    if (
      hideMobileLocalAutomations &&
      (tab === "automations" || tab === "triggers" || tab === "tasks")
    ) {
      setTab("apps");
    }
  }, [hideMobileLocalAutomations, setTab, tab]);

  const settingsTabGroup = useMemo(
    () => tabGroups.find((group) => group.label === "Settings") ?? null,
    [tabGroups],
  );
  const primaryDesktopGroups = useMemo(
    () => tabGroups.filter((group) => group.label !== "Settings"),
    [tabGroups],
  );

  const localizeNavLabel = useCallback(
    (label: string) =>
      t(NAV_LABEL_I18N_KEY[label] ?? label, { defaultValue: label }),
    [t],
  );

  // ── Active-app breadcrumb ────────────────────────────────────────────
  // Surfaces "Apps > <AppName>" in the header center so the user knows which
  // app they're inside. Three sources, in priority order:
  //
  //  1. Active game run (`activeGameRunId` resolved against `appRuns`).
  //  2. Active full-screen overlay app (`activeOverlayApp` resolved against
  //     the overlay registry — Companion, Shopify, Vincent, etc.).
  //  3. The current tab is an "apps tool tab" — LifeOps, Plugins, Skills,
  //     Trajectories, etc. These live at `/apps/<slug>` paths and belong to
  //     the Apps nav group, so the user mentally treats them as apps.
  //
  // Overlay apps render full-screen on top of every tab (App.tsx gates on
  // `activeOverlayApp !== null`), so the breadcrumb for sources (1) and (2)
  // is correct regardless of the underlying `tab` value.
  const activeAppCrumbLabel = useMemo(() => {
    if (activeGameRunId) {
      const run = appRuns.find((entry) => entry.runId === activeGameRunId);
      if (run) {
        const label = (run.displayName || run.appName).trim();
        return label.length > 0 ? label : null;
      }
    }
    if (activeOverlayApp) {
      const overlay = getOverlayApp(activeOverlayApp);
      if (overlay) {
        const label = (overlay.displayName || overlay.name).trim();
        return label.length > 0 ? label : null;
      }
      // Registry miss: don't leak the raw slug to the user. Hide the crumb
      // until the registry resolves the app (or the active app changes).
      return null;
    }
    if (isAppsToolTab(tab)) {
      // Tool tabs use English titles via titleForTab; localizeNavLabel maps
      // those to i18n keys when present (e.g. "LifeOps" → "nav.lifeops") and
      // falls back to the literal label otherwise.
      const title = titleForTab(tab);
      const label = localizeNavLabel(title);
      return label.length > 0 ? label : null;
    }
    return null;
  }, [activeGameRunId, activeOverlayApp, appRuns, localizeNavLabel, tab]);

  // Whether the active crumb originates from an overlay/game run vs a tool
  // tab. The home-click handler differs between these: overlay/run crumbs
  // need the state cleared, tool-tab crumbs just navigate.
  const breadcrumbSourceIsApp = useMemo(() => {
    if (activeGameRunId) {
      return appRuns.some((entry) => entry.runId === activeGameRunId);
    }
    if (activeOverlayApp) {
      return getOverlayApp(activeOverlayApp) !== undefined;
    }
    return false;
  }, [activeGameRunId, activeOverlayApp, appRuns]);

  // Breadcrumb "home" click sends the user back to the Apps catalog.
  // For overlay apps and game runs this also clears the active state — that
  // mirrors `OverlayAppContext.exitToApps()` ("Navigate back to the apps tab
  // and close this overlay"). For tool tabs (LifeOps, Plugins, ...) we only
  // navigate; there's no overlay state to clear.
  const handleAppCrumbHomeClick = useCallback(() => {
    if (breadcrumbSourceIsApp) {
      setState("activeOverlayApp", null);
      setState("activeGameRunId", "");
    }
    setTab("apps");
  }, [breadcrumbSourceIsApp, setState, setTab]);

  const localizeTabGroup = useCallback(
    (group: TabGroup) => ({
      description:
        group.description && NAV_DESCRIPTION_I18N_KEY[group.label]
          ? t(NAV_DESCRIPTION_I18N_KEY[group.label], {
              defaultValue: group.description,
            })
          : group.description,
      label: localizeNavLabel(group.label),
    }),
    [localizeNavLabel, t],
  );

  const breadcrumbNode = useMemo(() => {
    if (!activeAppCrumbLabel) return null;
    const appsLabel = localizeNavLabel("Apps");
    const homeButtonClass = isMobileViewport
      ? "inline-flex h-11 min-h-11 items-center rounded-[var(--radius-sm)] px-2 font-medium text-muted transition-colors hover:bg-bg-hover/40 hover:text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      : "inline-flex items-center rounded-[var(--radius-sm)] px-1 py-0.5 font-medium text-muted transition-colors hover:bg-bg-hover/40 hover:text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
    return (
      <nav
        className="flex min-w-0 items-center gap-1 px-2 text-xs"
        aria-label={t("aria.breadcrumb", { defaultValue: "Breadcrumb" })}
        data-testid="header-breadcrumb"
      >
        <button
          type="button"
          onClick={handleAppCrumbHomeClick}
          onPointerDown={stopHeaderPointerPropagation}
          data-testid="header-breadcrumb-home"
          data-no-camera-drag="true"
          className={homeButtonClass}
        >
          {appsLabel}
        </button>
        <ChevronRight
          className="h-3 w-3 shrink-0 text-muted/60"
          aria-hidden="true"
        />
        <span
          className="truncate px-1 py-0.5 font-medium text-txt"
          data-testid="header-breadcrumb-current"
          aria-current="page"
          title={activeAppCrumbLabel}
        >
          {activeAppCrumbLabel}
        </span>
      </nav>
    );
  }, [
    activeAppCrumbLabel,
    handleAppCrumbHomeClick,
    isMobileViewport,
    localizeNavLabel,
    stopHeaderPointerPropagation,
    t,
  ]);

  const openCloudBilling = useCallback(() => {
    setState("cloudDashboardView", "billing");
    setTab("settings");
  }, [setState, setTab]);

  const chatInferenceNotice = useMemo(() => {
    if (tab !== "chat") return null;
    return resolveCompanionInferenceNotice({
      chatLastUsageModel: chatLastUsage?.model,
      elizaCloudAuthRejected,
      elizaCloudConnected,
      elizaCloudCreditsError,
      elizaCloudEnabled,
      hasInterruptedAssistant: (conversationMessages ?? []).some(
        (message) => message.role === "assistant" && message.interrupted,
      ),
      t,
    });
  }, [
    chatLastUsage?.model,
    conversationMessages,
    elizaCloudAuthRejected,
    elizaCloudConnected,
    elizaCloudCreditsError,
    elizaCloudEnabled,
    tab,
    t,
  ]);

  const handleChatInferenceAlertClick = useCallback(() => {
    if (!chatInferenceNotice) return;
    if (chatInferenceNotice.kind === "cloud") {
      setState("cloudDashboardView", "billing");
    }
    setTab("settings");
  }, [chatInferenceNotice, setState, setTab]);

  const settingsButtonLabel = settingsTabGroup
    ? localizeTabGroup(settingsTabGroup).label
    : t("nav.settings", { defaultValue: "Settings" });
  const isSettingsActive = settingsTabGroup?.tabs.includes(tab) ?? false;

  const desktopTaskToggle = onToggleTasksPanel ? (
    <Button
      size="icon"
      variant="ghost"
      className={`${TOPBAR_ICON_BUTTON_CLASSNAME} ${
        tasksEventsPanelOpen ? TOPBAR_ICON_BUTTON_ACTIVE_CLASSNAME : ""
      }`}
      onClick={onToggleTasksPanel}
      onPointerDown={stopHeaderPointerPropagation}
      aria-label={t("taskseventspanel.Title", {
        defaultValue: "Tasks & Events",
      })}
      aria-pressed={tasksEventsPanelOpen}
      style={HEADER_BUTTON_STYLE}
      data-testid="header-tasks-events-toggle"
      data-no-camera-drag="true"
    >
      <ListTodo className="pointer-events-none h-4 w-4" />
    </Button>
  ) : null;

  const settingsButton = (
    <Button
      size="icon"
      variant="ghost"
      className={`${TOPBAR_RIGHT_ICON_BUTTON_CLASSNAME} ${
        isSettingsActive ? TOPBAR_RIGHT_ICON_BUTTON_ACTIVE_CLASSNAME : ""
      }`}
      onClick={() => setTab(settingsTabGroup?.tabs[0] ?? "settings")}
      onPointerDown={stopHeaderPointerPropagation}
      aria-label={settingsButtonLabel}
      title={settingsButtonLabel}
      style={HEADER_BUTTON_STYLE}
      data-testid="header-settings-button"
      data-no-camera-drag="true"
    >
      <Settings className="pointer-events-none h-4 w-4" />
    </Button>
  );

  const mobileBottomNav = isMobileViewport ? (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border/55 bg-bg/95 pt-1.5 shadow-[0_-1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl"
      style={{
        paddingBottom: "max(0.375rem, env(safe-area-inset-bottom, 0px))",
        paddingLeft: "max(0.5rem, var(--safe-area-left, 0px))",
        paddingRight: "max(0.5rem, var(--safe-area-right, 0px))",
      }}
      aria-label={t("aria.navMenu")}
      data-testid="header-mobile-bottom-nav"
      data-no-camera-drag="true"
    >
      <div
        className="grid min-w-0 items-center gap-1 overflow-hidden"
        style={{
          gridTemplateColumns: `repeat(${tabGroups.length}, minmax(0, 1fr))`,
        }}
      >
        {tabGroups.map((group) => {
          const primaryTab = group.tabs[0];
          const isActive = group.tabs.includes(tab);
          const localizedGroup = localizeTabGroup(group);

          return (
            <Button
              variant="ghost"
              key={group.label}
              data-testid={`header-mobile-bottom-nav-button-${primaryTab}`}
              className={`${MOBILE_BOTTOM_NAV_BUTTON_CLASSNAME} ${
                isActive ? MOBILE_BOTTOM_NAV_BUTTON_ACTIVE_CLASSNAME : ""
              }`}
              onClick={() => setTab(primaryTab)}
              onPointerDown={stopHeaderPointerPropagation}
              aria-label={localizedGroup.label}
              aria-current={isActive ? "page" : undefined}
              title={localizedGroup.label}
              style={HEADER_BUTTON_STYLE}
              data-no-camera-drag="true"
            >
              <group.icon className="pointer-events-none h-4.5 w-4.5 shrink-0" />
            </Button>
          );
        })}
      </div>
    </nav>
  ) : null;

  const rightDesktopControls = (
    <div
      className="flex min-w-0 items-center justify-end gap-1.5"
      data-no-camera-drag="true"
    >
      {pageRightExtras}
      {desktopTaskToggle}
      {chatInferenceNotice ? (
        <InferenceCloudAlertButton
          notice={chatInferenceNotice}
          onClick={handleChatInferenceAlertClick}
        />
      ) : null}
      {showCloudStatus ? (
        <CloudStatusBadge
          connected={elizaCloudConnected}
          credits={elizaCloudCredits}
          creditsLow={elizaCloudCreditsLow}
          creditsCritical={elizaCloudCreditsCritical}
          authRejected={elizaCloudAuthRejected}
          creditsError={elizaCloudCreditsError}
          t={t}
          onClick={openCloudBilling}
          dataTestId="header-cloud-status"
        />
      ) : null}
      <div className="max-[819px]:hidden">
        <LanguageDropdown
          uiLanguage={uiLanguage}
          setUiLanguage={setUiLanguage}
          t={t}
          variant="titlebar"
        />
      </div>
      <div className="max-[819px]:hidden">
        <ThemeToggle
          uiTheme={uiTheme}
          setUiTheme={setUiTheme}
          t={t}
          variant="titlebar"
        />
      </div>
      {settingsButton}
    </div>
  );

  return (
    <>
      <header
        className="sticky top-0 z-30 w-full select-none border-b border-border/50 bg-bg/88 shadow-[0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl"
        style={{ WebkitUserSelect: "none", userSelect: "none" }}
      >
        <div
          className={showMacDesktopTitleBar ? "pointer-events-auto" : undefined}
          data-window-titlebar={showMacDesktopTitleBar ? "true" : undefined}
          data-testid={
            showMacDesktopTitleBar ? "desktop-window-titlebar" : undefined
          }
        >
          <div
            className={
              isMobileViewport
                ? `grid ${
                    mobileLeft ||
                    breadcrumbNode ||
                    chatInferenceNotice ||
                    pageRightExtras
                      ? "min-h-[2.75rem]"
                      : "min-h-0"
                  } grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2`
                : "grid min-h-[2.375rem] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-3"
            }
            data-window-titlebar-padding={
              showMacDesktopTitleBar ? "true" : undefined
            }
            style={titlebarPaddingStyle}
          >
            {isMobileViewport ? (
              <>
                {/*
                 * Mobile header — single canonical row that sits directly
                 * below the system status bar (the body has
                 * padding-top: env(safe-area-inset-top), so this row's
                 * sticky `top: 0` lands just under the iPhone notch /
                 * Dynamic Island and the Android status icons). Buttons at
                 * the left and right edges naturally bracket the notch.
                 */}
                <div
                  className="flex min-w-0 items-center justify-start"
                  data-no-camera-drag="true"
                >
                  {mobileLeft}
                </div>
                <div
                  className={
                    breadcrumbNode || chatInferenceNotice
                      ? "flex h-[2.375rem] min-w-0 items-center justify-center gap-2"
                      : "pointer-events-none min-w-0"
                  }
                  data-testid={
                    showMacDesktopTitleBar
                      ? "desktop-window-titlebar-drag-zone"
                      : undefined
                  }
                  data-no-camera-drag={
                    breadcrumbNode || chatInferenceNotice ? "true" : undefined
                  }
                  aria-hidden={
                    breadcrumbNode || chatInferenceNotice ? undefined : "true"
                  }
                >
                  {breadcrumbNode}
                  {chatInferenceNotice ? (
                    <InferenceCloudAlertButton
                      notice={chatInferenceNotice}
                      onClick={handleChatInferenceAlertClick}
                    />
                  ) : null}
                </div>
                <div
                  className="flex min-w-0 items-center justify-end"
                  data-no-camera-drag="true"
                >
                  {pageRightExtras}
                </div>
              </>
            ) : (
              <>
                <nav
                  className="scrollbar-hide flex min-w-0 items-center gap-1 overflow-x-auto pr-2"
                  aria-label={t("aria.navMenu")}
                  data-no-camera-drag="true"
                >
                  {primaryDesktopGroups.map((group) => {
                    const primaryTab = group.tabs[0];
                    const isActive = group.tabs.includes(tab);
                    const localizedGroup = localizeTabGroup(group);

                    return (
                      <Button
                        variant="ghost"
                        key={group.label}
                        data-testid={`header-nav-button-${primaryTab}`}
                        className={`${TOPBAR_NAV_BUTTON_CLASSNAME} ${
                          isActive ? TOPBAR_NAV_BUTTON_ACTIVE_CLASSNAME : ""
                        }`}
                        onClick={() => setTab(primaryTab)}
                        onPointerDown={stopHeaderPointerPropagation}
                        aria-label={localizedGroup.label}
                        title={
                          collapseDesktopNavLabels
                            ? localizedGroup.label
                            : (localizedGroup.description ??
                              localizedGroup.label)
                        }
                        style={HEADER_BUTTON_STYLE}
                        data-no-camera-drag="true"
                      >
                        <group.icon className="pointer-events-none h-4 w-4 shrink-0" />
                        <span
                          data-testid={`header-nav-label-${primaryTab}`}
                          className={`pointer-events-none truncate ${
                            collapseDesktopNavLabels ? "hidden" : "inline"
                          }`}
                        >
                          {localizedGroup.label}
                        </span>
                      </Button>
                    );
                  })}
                </nav>
                {breadcrumbNode ? (
                  <div
                    className="flex h-[2.375rem] min-w-0 items-center justify-center"
                    data-testid={
                      showMacDesktopTitleBar
                        ? "desktop-window-titlebar-drag-zone"
                        : undefined
                    }
                    data-no-camera-drag="true"
                  >
                    {breadcrumbNode}
                  </div>
                ) : (
                  <div
                    className="pointer-events-none h-[2.375rem] w-[clamp(3rem,8vw,8rem)] min-w-0"
                    data-testid={
                      showMacDesktopTitleBar
                        ? "desktop-window-titlebar-drag-zone"
                        : undefined
                    }
                    aria-hidden="true"
                  />
                )}
                {rightDesktopControls}
              </>
            )}
          </div>
        </div>
      </header>
      {mobileBottomNav}
    </>
  );
}
