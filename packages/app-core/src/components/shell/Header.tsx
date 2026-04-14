import { LanguageDropdown } from "../shared/LanguageDropdown";
import { ThemeToggle } from "../shared/ThemeToggle";
import { getTabGroups } from "../../navigation";
import type { TabGroup } from "../../navigation";
import { useApp } from "../../state/useApp";
import { Button } from "@elizaos/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@elizaos/ui/components/ui/dialog";
import { ListTodo, Menu, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CloudStatusBadge } from "../cloud/CloudStatusBadge";
import { InferenceCloudAlertButton } from "@elizaos/app-companion/components/companion/InferenceCloudAlertButton";
import { resolveCompanionInferenceNotice } from "@elizaos/app-companion/components/companion/resolve-companion-inference-notice";
import { ShellHeaderControls } from "./ShellHeaderControls";

const NAV_LABEL_I18N_KEY: Record<string, string> = {
  Chat: "nav.chat",
  LifeOps: "nav.lifeops",
  Browser: "nav.browser",
  Companion: "nav.companion",
  Stream: "nav.stream",
  Character: "nav.character",
  Wallet: "nav.wallet",
  Knowledge: "nav.knowledge",
  Connectors: "nav.social",
  Apps: "nav.apps",
  Settings: "nav.settings",
  Heartbeats: "nav.heartbeats",
};

interface HeaderProps {
  mobileLeft?: ReactNode;
  pageRightExtras?: ReactNode;
  transparent?: boolean;
  hideCloudCredits?: boolean;
  tasksEventsPanelOpen?: boolean;
  onToggleTasksPanel?: () => void;
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
    elizaCloudEnabled,
    elizaCloudConnected,
    elizaCloudCredits,
    elizaCloudCreditsCritical,
    elizaCloudCreditsLow,
    elizaCloudAuthRejected,
    elizaCloudCreditsError,
    tab,
    setTab,
    setState,
    plugins,
    browserEnabled,
    walletEnabled,
    loadDropStatus,
    uiLanguage,
    setUiLanguage,
    uiTheme,
    setUiTheme,
    conversationMessages,
    chatLastUsage,
    t,
  } = useApp();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuPortalContainer =
    typeof document !== "undefined" ? document.body : undefined;

  useEffect(() => {
    void loadDropStatus();
  }, [loadDropStatus]);

  // Close mobile menu on escape key
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const streamingEnabled = useMemo(
    () =>
      plugins.some(
        (plugin) => plugin.id === "streaming-base" && plugin.enabled,
      ),
    [plugins],
  );
  const tabGroups = useMemo(
    () => getTabGroups(streamingEnabled, walletEnabled, browserEnabled),
    [streamingEnabled, walletEnabled, browserEnabled],
  );
  const activeTabGroup = useMemo(
    () =>
      tabGroups.find((group) => group.tabs.includes(tab)) ??
      tabGroups[0] ??
      null,
    [tab, tabGroups],
  );

  // Outside the companion overlay the shell is always in desktop/native mode.
  // The mode-selector pill only appears inside the companion overlay header.
  const activeShellView = "desktop" as const;
  const isDesktopShell = true;
  const showNavigationMenu = true;
  const showCloudStatus = !hideCloudCredits;
  const headerFrameClassName = "";
  const headerShellClassName =
    "border-transparent bg-transparent shadow-none ring-0 backdrop-blur-none";

  const openCloudBilling = () => {
    setState("cloudDashboardView", "billing");
    setTab("settings");
    setMobileMenuOpen(false);
  };

  const chatInferenceNotice = useMemo(() => {
    if (tab !== "chat") return null;
    return resolveCompanionInferenceNotice({
      elizaCloudConnected,
      elizaCloudAuthRejected,
      elizaCloudCreditsError,
      elizaCloudEnabled,
      chatLastUsageModel: chatLastUsage?.model,
      hasInterruptedAssistant: (conversationMessages ?? []).some(
        (m) => m.role === "assistant" && m.interrupted,
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
    setMobileMenuOpen(false);
  }, [chatInferenceNotice, setState, setTab]);

  const renderMobileMenuThemeToggle = () => (
    <div
      data-testid="header-theme-toggle-mobile"
      className="flex items-center justify-end"
    >
      <ThemeToggle
        uiTheme={uiTheme}
        setUiTheme={setUiTheme}
        t={t}
        className="!h-11 !w-11 !min-h-11 !min-w-11"
      />
    </div>
  );

  const renderMobileMenuLanguageDropdown = () => (
    <div data-testid="header-language-dropdown-mobile" className="shrink-0">
      <LanguageDropdown
        uiLanguage={uiLanguage}
        setUiLanguage={setUiLanguage}
        t={t}
        menuPlacement="top-end"
        triggerClassName="!h-11 !min-h-11 !rounded-xl !px-3.5"
      />
    </div>
  );

  useEffect(() => {
    setState("chatMode", "power");
  }, [setState]);

  useEffect(() => {
    if (showNavigationMenu) return;
    setMobileMenuOpen(false);
  }, [showNavigationMenu]);

  return (
    <>
      <header
        className="sticky top-0 z-20 w-full select-none overflow-visible"
        style={{ WebkitUserSelect: "none", userSelect: "none" }}
        data-no-camera-drag="true"
      >
        <div className="px-2 py-1">
          <div
            className={`pointer-events-auto relative mx-auto w-full rounded-[20px] border bg-clip-padding transition-all sm:rounded-[22px] ${headerFrameClassName} ${headerShellClassName}`}
            data-testid="header-glass-shell"
          >
            <ShellHeaderControls
              activeShellView={activeShellView}
              onShellViewChange={() => {
                /* pill hidden — no-op */
              }}
              showShellViewToggle={false}
              uiLanguage={uiLanguage}
              setUiLanguage={setUiLanguage}
              uiTheme={uiTheme}
              setUiTheme={setUiTheme}
              t={t}
              languageDropdownClassName="hidden sm:inline-flex"
              languageDropdownWrapperTestId="header-language-dropdown-desktop"
              themeToggleWrapperClassName="hidden sm:flex"
              themeToggleWrapperTestId="header-theme-toggle-desktop"
              rightExtras={
                <>
                  {pageRightExtras}
                  {onToggleTasksPanel ? (
                    <Button
                      size="icon"
                      variant={tasksEventsPanelOpen ? "default" : "outline"}
                      className="inline-flex h-11 w-11 min-h-touch min-w-touch items-center justify-center rounded-xl border border-border/42 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_14px_32px_rgba(3,5,10,0.14)] ring-1 ring-inset ring-white/6 backdrop-blur-xl supports-[backdrop-filter]:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_62%,transparent),color-mix(in_srgb,var(--bg)_34%,transparent))] transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-accent/55 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_78%,transparent),color-mix(in_srgb,var(--bg-hover)_52%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_18px_36px_rgba(3,5,10,0.18)] active:scale-[0.98] disabled:active:scale-100 disabled:hover:border-border/42 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] disabled:hover:text-txt"
                      onClick={onToggleTasksPanel}
                      aria-label={t("taskseventspanel.Title", {
                        defaultValue: "Tasks & Events",
                      })}
                      aria-pressed={tasksEventsPanelOpen}
                      style={{
                        clipPath: "none",
                        WebkitClipPath: "none",
                        touchAction: "manipulation",
                      }}
                      data-testid="header-tasks-events-toggle"
                    >
                      <ListTodo className="pointer-events-none w-4 h-4" />
                    </Button>
                  ) : null}
                  {mobileLeft ? (
                    <div className="shrink-0 sm:hidden">{mobileLeft}</div>
                  ) : null}
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
                </>
              }
              trailingExtras={
                showNavigationMenu ? (
                  <Button
                    size="icon"
                    variant="outline"
                    className="sm:hidden inline-flex h-11 w-11 min-h-touch min-w-touch items-center justify-center rounded-xl border border-border/42 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_14px_32px_rgba(3,5,10,0.14)] ring-1 ring-inset ring-white/6 backdrop-blur-xl supports-[backdrop-filter]:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_62%,transparent),color-mix(in_srgb,var(--bg)_34%,transparent))] transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-accent/55 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_78%,transparent),color-mix(in_srgb,var(--bg-hover)_52%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_18px_36px_rgba(3,5,10,0.18)] active:scale-[0.98] disabled:active:scale-100 disabled:hover:border-border/42 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] disabled:hover:text-txt"
                    onClick={() => setMobileMenuOpen(true)}
                    aria-label={t("aria.openNavMenu")}
                    aria-expanded={mobileMenuOpen}
                    style={{
                      clipPath: "none",
                      WebkitClipPath: "none",
                      touchAction: "manipulation",
                    }}
                  >
                    <Menu className="pointer-events-none w-5 h-5" />
                  </Button>
                ) : null
              }
            >
              {showNavigationMenu ? (
                <nav className="scrollbar-hide hidden flex-1 items-center justify-start gap-1.5 overflow-x-auto whitespace-nowrap sm:flex">
                  {tabGroups.map((group: TabGroup) => {
                    const primaryTab = group.tabs[0];
                    const isActive = group.tabs.includes(tab);
                    return (
                      <Button
                        variant={isActive ? "default" : "ghost"}
                        key={group.label}
                        data-testid={`header-nav-button-${primaryTab}`}
                        className={`relative z-10 min-h-touch shrink-0 rounded-xl border border-transparent px-3 py-2.5 text-xs transition-all duration-200 md:px-3.5 xl:px-4 ${
                          isActive
                            ? "border-accent/30 bg-accent/12 text-txt font-semibold shadow-[0_2px_10px_rgba(3,5,10,0.08)] ring-1 ring-inset ring-accent/18 dark:shadow-[0_0_0_1px_rgba(var(--accent-rgb),0.14),0_0_14px_rgba(var(--accent-rgb),0.14)]"
                            : "text-muted hover:border-border/45 hover:bg-bg-hover/70 hover:text-txt"
                        }`}
                        onClick={() => setTab(primaryTab)}
                        title={group.description}
                        style={{
                          clipPath: "none",
                          WebkitClipPath: "none",
                          touchAction: "manipulation",
                        }}
                      >
                        <group.icon className="pointer-events-none h-3.5 w-3.5 shrink-0" />
                        <span
                          data-testid={`header-nav-label-${primaryTab}`}
                          className="pointer-events-none inline"
                        >
                          {t(NAV_LABEL_I18N_KEY[group.label] ?? group.label)}
                        </span>
                      </Button>
                    );
                  })}
                </nav>
              ) : null}
            </ShellHeaderControls>
          </div>
        </div>
      </header>

      {showNavigationMenu ? (
        <Dialog open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <DialogContent
            container={mobileMenuPortalContainer}
            showCloseButton={false}
            className="fixed left-auto right-0 top-0 z-[240] flex h-[100dvh] w-[min(22rem,88vw)] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-l border-border/60 bg-bg/98 p-0 shadow-[0_24px_70px_rgba(2,8,23,0.34)] backdrop-blur-2xl data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right max-sm:!bottom-0 max-sm:!left-auto max-sm:!right-0 max-sm:!top-0 max-sm:!max-h-[100dvh] max-sm:!w-[min(22rem,88vw)] max-sm:!translate-x-0 max-sm:!translate-y-0 max-sm:!rounded-none max-sm:data-[state=closed]:slide-out-to-right max-sm:data-[state=open]:slide-in-from-right sm:hidden"
          >
            <DialogHeader className="border-b border-border/50 px-4 py-3 text-left">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold uppercase tracking-[0.1em] text-muted">
                    {t("aria.navMenu")}
                  </div>
                  <DialogTitle className="truncate text-sm font-medium text-txt">
                    {activeTabGroup
                      ? t(
                          NAV_LABEL_I18N_KEY[activeTabGroup.label] ??
                            activeTabGroup.label,
                        )
                      : t("aria.navMenu")}
                  </DialogTitle>
                  <DialogDescription className="sr-only">
                    {t("header.MobileNavigationDescription", {
                      defaultValue: "Navigate between sections",
                    })}
                  </DialogDescription>
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0 inline-flex h-11 w-11 min-h-touch min-w-touch items-center justify-center rounded-xl border border-border/42 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_14px_32px_rgba(3,5,10,0.14)] ring-1 ring-inset ring-white/6 backdrop-blur-xl supports-[backdrop-filter]:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_62%,transparent),color-mix(in_srgb,var(--bg)_34%,transparent))] transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-accent/55 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_78%,transparent),color-mix(in_srgb,var(--bg-hover)_52%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_18px_36px_rgba(3,5,10,0.18)] active:scale-[0.98] disabled:active:scale-100 disabled:hover:border-border/42 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] disabled:hover:text-txt"
                  onClick={() => setMobileMenuOpen(false)}
                  aria-label={t("aria.closeNavMenu")}
                  style={{
                    clipPath: "none",
                    WebkitClipPath: "none",
                    touchAction: "manipulation",
                  }}
                >
                  <X className="pointer-events-none h-4 w-4" />
                </Button>
              </div>
            </DialogHeader>
            <div className="flex flex-1 flex-col px-3 py-3">
              <div className="flex-1 overflow-y-auto pr-1">
                <div className="flex flex-col gap-1">
                  {tabGroups.map((group: TabGroup, index) => {
                    const primaryTab = group.tabs[0];
                    const isActive = group.tabs.includes(tab);
                    return (
                      <Button
                        variant={isActive ? "default" : "ghost"}
                        key={group.label}
                        className={`flex min-h-[48px] w-full rounded-xl border px-3 py-3 text-sm font-medium transition-all duration-200 ${
                          isActive
                            ? "border-accent/30 bg-accent/12 text-txt shadow-[0_2px_10px_rgba(3,5,10,0.08)] ring-1 ring-inset ring-accent/18 dark:shadow-[0_0_0_1px_rgba(var(--accent-rgb),0.14),0_0_14px_rgba(var(--accent-rgb),0.14)]"
                            : "border-transparent bg-transparent text-txt hover:border-border/45 hover:bg-bg-hover/70"
                        }`}
                        style={{
                          clipPath: "none",
                          WebkitClipPath: "none",
                          touchAction: "manipulation",
                          animationDelay: `${index * 50}ms`,
                        }}
                        onClick={() => {
                          setTab(primaryTab);
                          setMobileMenuOpen(false);
                        }}
                      >
                        <group.icon className="pointer-events-none h-4 w-4 shrink-0" />
                        <div className="pointer-events-none flex-1 text-left">
                          <div className="font-medium">
                            {t(NAV_LABEL_I18N_KEY[group.label] ?? group.label)}
                          </div>
                          {group.description && (
                            <div className="text-xs-tight text-muted mt-0.5">
                              {group.description}
                            </div>
                          )}
                        </div>
                      </Button>
                    );
                  })}
                </div>
              </div>
              <div className="mt-3 flex flex-col gap-3 border-t border-border/50 pt-3">
                <div className="flex items-center justify-end gap-2">
                  {renderMobileMenuLanguageDropdown()}
                  {renderMobileMenuThemeToggle()}
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
