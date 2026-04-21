import {
  InferenceCloudAlertButton,
  resolveCompanionInferenceNotice,
} from "@elizaos/app-companion/ui";
import { isElectrobunRuntime } from "@elizaos/app-core/bridge/electrobun-runtime";
import { CloudStatusBadge } from "@elizaos/app-core/components/cloud/CloudStatusBadge";
import { LanguageDropdown } from "@elizaos/app-core/components/shared/LanguageDropdown";
import { ThemeToggle } from "@elizaos/app-core/components/shared/ThemeToggle";
import { useBranding } from "@elizaos/app-core/config/branding";
import { useMediaQuery } from "@elizaos/app-core/hooks";
import { getTabGroups, type TabGroup } from "@elizaos/app-core/navigation";
import {
  isDetachedWindowShell,
  resolveWindowShellRoute,
} from "@elizaos/app-core/platform/window-shell";
import { useApp } from "@elizaos/app-core/state";
import { ListTodo, Settings } from "lucide-react";
import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo } from "react";
import { Button } from "../ui/button";
import { HEADER_BUTTON_STYLE } from "./ShellHeaderControls";

const MOBILE_HEADER_MEDIA_QUERY = "(max-width: 639px)";
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
  Knowledge: "nav.knowledge",
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
const MOBILE_BOTTOM_NAV_BUTTON_CLASSNAME =
  "relative inline-flex min-w-0 flex-1 items-center justify-center rounded-[0.85rem] px-2 py-2.5 text-muted transition-colors duration-150 after:absolute after:inset-x-3 after:bottom-[0.15rem] after:h-[2px] after:rounded-full after:bg-accent/60 after:opacity-0 after:transition-opacity after:duration-150";

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
  const branding = useBranding();
  const {
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
  const collapseDesktopNavLabels = useMediaQuery(
    DESKTOP_LABEL_COLLAPSE_MEDIA_QUERY,
  );
  const showMacDesktopTitleBar = shouldShowMacDesktopTitleBar();
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

    if (showMacDesktopTitleBar) {
      document.documentElement.classList.add(
        "eliza-electrobun-custom-titlebar",
      );
    } else {
      document.documentElement.classList.remove(
        "eliza-electrobun-custom-titlebar",
      );
    }

    return () => {
      document.documentElement.classList.remove(
        "eliza-electrobun-custom-titlebar",
      );
    };
  }, [showMacDesktopTitleBar]);

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

  const streamingEnabled = useMemo(
    () =>
      plugins.some(
        (plugin) => plugin.id === "streaming-base" && plugin.enabled,
      ),
    [plugins],
  );
  const tabGroups = useMemo(
    () => getTabGroups(streamingEnabled, walletEnabled, browserEnabled),
    [browserEnabled, streamingEnabled, walletEnabled],
  );
  const settingsTabGroup = useMemo(
    () => tabGroups.find((group) => group.label === "Settings") ?? null,
    [tabGroups],
  );
  const primaryDesktopGroups = useMemo(
    () => tabGroups.filter((group) => group.label !== "Settings"),
    [tabGroups],
  );

  const localizeTabGroup = useCallback(
    (group: TabGroup) => ({
      description:
        group.description && NAV_DESCRIPTION_I18N_KEY[group.label]
          ? t(NAV_DESCRIPTION_I18N_KEY[group.label], {
              defaultValue: group.description,
            })
          : group.description,
      label: t(NAV_LABEL_I18N_KEY[group.label] ?? group.label, {
        defaultValue: group.label,
      }),
    }),
    [t],
  );

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
      <div className="max-[860px]:hidden">
        <LanguageDropdown
          uiLanguage={uiLanguage}
          setUiLanguage={setUiLanguage}
          t={t}
          variant="titlebar"
        />
      </div>
      <div className="max-[860px]:hidden">
        <ThemeToggle
          uiTheme={uiTheme}
          setUiTheme={setUiTheme}
          t={t}
          variant="titlebar"
        />
      </div>
      <Button
        size="icon"
        variant="ghost"
        className={`${TOPBAR_ICON_BUTTON_CLASSNAME} ${
          isSettingsActive ? TOPBAR_ICON_BUTTON_ACTIVE_CLASSNAME : ""
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
    </div>
  );

  return (
    <>
      <header
        className="sticky top-0 z-30 w-full select-none border-b border-border/50 bg-bg/88 shadow-[0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl"
        style={{ WebkitUserSelect: "none", userSelect: "none" }}
        data-no-camera-drag="true"
      >
        <div
          className={showMacDesktopTitleBar ? "pointer-events-auto" : undefined}
          data-window-titlebar={showMacDesktopTitleBar ? "true" : undefined}
          data-testid={
            showMacDesktopTitleBar ? "desktop-window-titlebar" : undefined
          }
        >
          <div
            className="grid min-h-[2.375rem] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-3"
            data-window-titlebar-padding={
              showMacDesktopTitleBar ? "true" : undefined
            }
          >
            {isMobileViewport ? (
              <>
                <div
                  className="flex min-w-0 items-center justify-start gap-2"
                  data-no-camera-drag="true"
                >
                  {mobileLeft}
                </div>
                <div
                  className="pointer-events-none truncate px-2 text-sm font-medium tracking-[0.01em] text-txt/94"
                  data-testid={
                    showMacDesktopTitleBar
                      ? "desktop-window-titlebar-label"
                      : undefined
                  }
                >
                  {branding.appName}
                </div>
                <div
                  className="flex min-w-0 items-center justify-end gap-2"
                  data-no-camera-drag="true"
                >
                  {pageRightExtras}
                  {desktopTaskToggle}
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
                <div
                  className="pointer-events-none truncate px-4 text-sm font-medium tracking-[0.01em] text-txt/94"
                  data-testid={
                    showMacDesktopTitleBar
                      ? "desktop-window-titlebar-label"
                      : undefined
                  }
                >
                  {branding.appName}
                </div>
                {rightDesktopControls}
              </>
            )}
          </div>
        </div>
      </header>

      {isMobileViewport ? (
        <div className="fixed inset-x-0 bottom-0 z-40 px-2 pb-[max(var(--safe-area-bottom,0px),0.5rem)] pt-2 sm:hidden">
          <nav
            className="scrollbar-hide flex items-stretch gap-1 overflow-x-auto rounded-[1rem] border border-border/60 bg-card/90 px-1.5 py-1.5 shadow-[0_18px_50px_rgba(2,8,23,0.22)] backdrop-blur-2xl"
            aria-label={t("aria.navMenu")}
            data-testid="header-mobile-bottom-nav"
            data-no-camera-drag="true"
          >
            {tabGroups.map((group) => {
              const primaryTab = group.tabs[0];
              const isActive = group.tabs.includes(tab);
              const localizedGroup = localizeTabGroup(group);

              return (
                <Button
                  variant="ghost"
                  key={group.label}
                  className={`${MOBILE_BOTTOM_NAV_BUTTON_CLASSNAME} ${
                    isActive
                      ? "text-accent after:opacity-100"
                      : "hover:text-txt"
                  }`}
                  onClick={() => setTab(primaryTab)}
                  onPointerDown={stopHeaderPointerPropagation}
                  aria-label={localizedGroup.label}
                  title={localizedGroup.label}
                  style={HEADER_BUTTON_STYLE}
                  data-no-camera-drag="true"
                >
                  <group.icon className="pointer-events-none h-4.5 w-4.5 shrink-0" />
                  <span className="sr-only">{localizedGroup.label}</span>
                </Button>
              );
            })}
          </nav>
        </div>
      ) : null}
    </>
  );
}
