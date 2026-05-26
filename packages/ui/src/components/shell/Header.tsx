import { Capacitor } from "@capacitor/core";
import { ChevronRight, ListTodo, Settings } from "lucide-react";
import type {
  CSSProperties,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import { MOBILE_RUNTIME_MODE_CHANGED_EVENT } from "../../events";
import { readPersistedMobileRuntimeMode } from "../../first-run/mobile-runtime-mode";
import { useMediaQuery } from "../../hooks";
import { isAppsToolTab, titleForTab } from "../../navigation";
import {
  isDetachedWindowShell,
  resolveWindowShellRoute,
} from "../../platform/window-shell";
import { useApp } from "../../state";
import { useIsDeveloperMode } from "../../state/useDeveloperMode";
import { getOverlayApp } from "../apps/overlay-app-registry";
import { CloudStatusBadge } from "../cloud/CloudStatusBadge";
import { OwnerBadge } from "../composites/OwnerBadge";
import { LanguageDropdown } from "../shared/LanguageDropdown";
import { ThemeToggle } from "../shared/ThemeToggle";
import { Button } from "../ui/button";
import { HEADER_BUTTON_STYLE } from "./ShellHeaderControls";

const MOBILE_HEADER_MEDIA_QUERY = "(max-width: 819px)";
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

const TOPBAR_ICON_BUTTON_CLASSNAME =
  "relative inline-flex h-[2.375rem] w-[2.375rem] min-h-[2.375rem] min-w-[2.375rem] shrink-0 items-center justify-center rounded-md border border-transparent bg-transparent text-muted transition-colors duration-150 hover:text-txt after:absolute after:inset-x-2 after:bottom-0 after:h-[3px] after:rounded-t-full after:bg-accent/70 after:opacity-0 after:transition-opacity after:duration-150 hover:after:opacity-55";
const TOPBAR_ICON_BUTTON_ACTIVE_CLASSNAME = "text-accent after:opacity-100";
const TOPBAR_RIGHT_ICON_BUTTON_CLASSNAME =
  "inline-flex h-[2.375rem] w-[2.375rem] min-h-[2.375rem] min-w-[2.375rem] shrink-0 items-center justify-center rounded-md border border-transparent !bg-transparent text-muted shadow-none ring-0 transition-colors duration-150 hover:!bg-transparent hover:text-txt active:!bg-transparent data-[state=open]:!bg-transparent";
const TOPBAR_RIGHT_ICON_BUTTON_ACTIVE_CLASSNAME = "text-accent";
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
  /**
   * When true, the mobile bottom nav bar is hidden. Used on the chat tab to
   * create a chat-first experience with no nav visible by default — the nav
   * reappears when the user navigates to any other tab.
   */
  hideNav?: boolean;
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
  hideNav: _hideNav = false,
}: HeaderProps) {
  const {
    activeGameRunId,
    activeOverlayApp,
    appRuns,
    elizaCloudAuthRejected,
    elizaCloudConnected,
    elizaCloudCredits,
    elizaCloudCreditsCritical,
    elizaCloudCreditsError,
    elizaCloudCreditsLow,
    loadDropStatus,
    ownerName,
    plugins,
    setState,
    setTab,
    setUiLanguage,
    setUiTheme,
    tab,
    t,
    uiLanguage,
    uiTheme,
  } = useApp();

  const isMobileViewport = useMediaQuery(MOBILE_HEADER_MEDIA_QUERY);
  const [mobileRuntimeMode, setMobileRuntimeMode] = useState(
    readPersistedMobileRuntimeMode,
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

    document.documentElement.classList.remove("eliza-mobile-bottom-nav");

    return () => {
      document.documentElement.classList.remove("eliza-mobile-bottom-nav");
    };
  }, []);

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

  const developerModeEnabled = useIsDeveloperMode();

  // Keep developer-mode filtering exercised here so Header still observes
  // plugin nav declarations, but the top/bottom nav bars are intentionally
  // not rendered. Views are launched from the Views view instead.
  useMemo(() => {
    for (const plugin of plugins) {
      if (!plugin.enabled) continue;
      const navTabs = plugin.app?.navTabs;
      if (!navTabs?.length) continue;
      const appDeveloperOnly = plugin.app?.developerOnly === true;
      for (const navTab of navTabs) {
        const isDeveloperOnly =
          appDeveloperOnly || navTab.developerOnly === true;
        if (isDeveloperOnly && !developerModeEnabled) continue;
      }
    }
  }, [plugins, developerModeEnabled]);

  const hideMobileLocalAutomations =
    isMobileViewport &&
    mobileRuntimeMode === "local" &&
    Capacitor.isNativePlatform();

  useEffect(() => {
    if (
      hideMobileLocalAutomations &&
      (tab === "automations" || tab === "triggers" || tab === "tasks")
    ) {
      setTab("apps");
    }
  }, [hideMobileLocalAutomations, setTab, tab]);

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

  const settingsButtonLabel = t("nav.settings", { defaultValue: "Settings" });
  const isSettingsActive = tab === "settings";

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
      onClick={() => setTab("settings")}
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

  const mobileBottomNav = null;

  const rightDesktopControls = (
    <div
      className="flex min-w-0 items-center justify-end gap-1.5"
      data-no-camera-drag="true"
    >
      {pageRightExtras}
      {ownerName ? (
        <OwnerBadge
          isOwner
          variant="inline"
          size="sm"
          tooltip={`OWNER: ${ownerName}`}
          data-testid="header-owner-badge"
        />
      ) : null}
      {desktopTaskToggle}
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
        className="sticky top-0 z-30 w-full select-none border-b border-border/50 bg-bg/88 shadow-[0_1px_0_rgba(255,255,255,0.04)] "
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
                    mobileLeft || breadcrumbNode || pageRightExtras
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
                    breadcrumbNode
                      ? "flex h-[2.375rem] min-w-0 items-center justify-center gap-2"
                      : "pointer-events-none min-w-0"
                  }
                  data-testid={
                    showMacDesktopTitleBar
                      ? "desktop-window-titlebar-drag-zone"
                      : undefined
                  }
                  data-no-camera-drag={breadcrumbNode ? "true" : undefined}
                  aria-hidden={breadcrumbNode ? undefined : "true"}
                >
                  {breadcrumbNode}
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
                <div
                  className="h-[2.375rem] min-w-0"
                  data-testid="header-nav-suppressed"
                  data-no-camera-drag="true"
                />
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
