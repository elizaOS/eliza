import { LanguageDropdown, ThemeToggle } from "@elizaos/app-core/components";
import { getTabGroups, type TabGroup } from "@elizaos/app-core/navigation";
import { useApp } from "@elizaos/app-core/state";
import { AlertTriangle, CircleDollarSign, Menu } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  HEADER_ICON_BUTTON_CLASSNAME,
  ShellHeaderControls,
} from "./shared/ShellHeaderControls";

const NAV_LABEL_I18N_KEY: Record<string, string> = {
  Chat: "nav.chat",
  Companion: "nav.companion",
  Stream: "nav.stream",
  Character: "nav.character",
  Wallets: "nav.wallets",
  Knowledge: "nav.knowledge",
  Connectors: "nav.social",
  Apps: "nav.apps",
  Settings: "nav.settings",
  Heartbeats: "nav.heartbeats",
  Advanced: "nav.advanced",
};

interface HeaderProps {
  mobileLeft?: ReactNode;
  transparent?: boolean;
  hideCloudCredits?: boolean;
}

export function Header({ mobileLeft, transparent = false, hideCloudCredits = false }: HeaderProps) {
  const {
    elizaCloudEnabled,
    elizaCloudConnected,
    elizaCloudCredits,
    elizaCloudCreditsCritical,
    elizaCloudCreditsLow,
    tab,
    setTab,
    setState,
    plugins,
    loadDropStatus,
    uiShellMode,
    switchShellView,
    uiLanguage,
    setUiLanguage,
    uiTheme,
    setUiTheme,
    t,
  } = useApp();

  const [copied, setCopied] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    void loadDropStatus();
  }, [loadDropStatus]);

  // Clear copied state after 2 seconds
  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [copied]);

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
    () => getTabGroups(streamingEnabled),
    [streamingEnabled],
  );

  const creditColor = elizaCloudCreditsCritical
    ? "border-danger text-danger bg-danger/10"
    : elizaCloudCreditsLow
      ? "border-warn text-warn bg-warn/10"
      : "border-ok text-ok bg-ok/10";

  const shellMode =
    tab === "character" || tab === "character-select"
      ? "native"
      : (uiShellMode ?? "companion");
  const activeShellView =
    shellMode === "companion"
      ? "companion"
      : tab === "character" || tab === "character-select"
        ? "character"
        : "desktop";
  const useMinimalHeaderChrome = transparent || activeShellView !== "desktop";
  const showNavigationMenu = activeShellView === "desktop";
  const showCloudCredits = activeShellView === "desktop" && !hideCloudCredits;
  const showCloudCreditsStatus =
    showCloudCredits && (elizaCloudEnabled || elizaCloudConnected);
  const cloudCreditsDisplay =
    elizaCloudCredits === null
      ? t("header.elizaCloudConnected")
      : `$${elizaCloudCredits.toFixed(2)}`;

  const handleShellViewChange = (
    view: "companion" | "character" | "desktop",
  ) => {
    switchShellView(view);
  };

  const openCloudBilling = () => {
    setState("cloudDashboardView", "billing");
    setTab("settings");
    setMobileMenuOpen(false);
  };

  const renderCloudCredits = (placement: "desktop" | "mobile-menu") => {
    if (!showCloudCreditsStatus) return null;

    if (elizaCloudConnected) {
      if (placement === "desktop") {
        return (
          <button
            type="button"
            data-testid="header-cloud-credits-desktop"
            className={`hidden shrink-0 items-center gap-1.5 px-2.5 py-1.5 h-11 border rounded-md font-mono text-[11px] sm:text-xs no-underline transition-all duration-200 hover:border-accent hover:text-txt hover:shadow-sm sm:inline-flex ${elizaCloudCredits === null ? "border-muted text-muted" : creditColor}`}
            title={t("header.CloudCreditsBalanc")}
            onClick={openCloudBilling}
          >
            <CircleDollarSign className="w-3.5 h-3.5" />
            {cloudCreditsDisplay}
          </button>
        );
      }

      return (
        <button
          type="button"
          data-testid="header-cloud-credits-mobile"
          className={`flex w-full items-center justify-between gap-3 px-3 py-3 border rounded-xl text-left no-underline transition-all duration-200 hover:border-accent hover:text-txt ${elizaCloudCredits === null ? "border-muted text-muted" : creditColor}`}
          title={t("header.CloudCreditsBalanc")}
          onClick={openCloudBilling}
        >
          <span className="flex min-w-0 items-center gap-3">
            <CircleDollarSign className="h-4 w-4 shrink-0" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium font-sans text-txt">
                {t("header.Cloud")}
              </span>
              <span className="truncate text-xs font-sans text-muted">
                {t("header.CloudCreditsBalanc")}
              </span>
            </span>
          </span>
          <span className="shrink-0 font-mono text-sm">
            {cloudCreditsDisplay}
          </span>
        </button>
      );
    }

    if (placement === "desktop") {
      return (
        <span className="hidden shrink-0 items-center gap-1 px-2.5 py-1.5 h-11 border border-danger text-danger bg-danger/10 rounded-md font-mono text-[11px] sm:text-xs sm:inline-flex">
          <AlertTriangle className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">
            {t("header.cloudDisconnected")}
          </span>
          <span className="sm:hidden">{t("header.Cloud")}</span>
        </span>
      );
    }

    return (
      <div
        data-testid="header-cloud-credits-mobile"
        className="flex w-full items-center gap-3 px-3 py-3 border border-danger text-danger bg-danger/10 rounded-xl"
      >
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-current">
            {t("header.Cloud")}
          </div>
          <div className="truncate text-xs text-danger/80">
            {t("header.cloudDisconnected")}
          </div>
        </div>
      </div>
    );
  };

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
    if (shellMode !== "native") return;
    setState("chatMode", "power");
  }, [setState, shellMode]);

  useEffect(() => {
    if (showNavigationMenu) return;
    setMobileMenuOpen(false);
  }, [showNavigationMenu]);

  return (
    <>
      <header
        className={`py-2 px-3 sm:py-3 sm:px-4 z-20 sticky top-0 w-full transition-all ${useMinimalHeaderChrome
            ? "border-b border-transparent bg-transparent backdrop-blur-0 shadow-none"
            : "border-b border-border/50 bg-bg/80 backdrop-blur-xl"
          }`}
      >
        <ShellHeaderControls
          activeShellView={activeShellView}
          onShellViewChange={handleShellViewChange}
          uiLanguage={uiLanguage}
          setUiLanguage={setUiLanguage}
          uiTheme={uiTheme}
          setUiTheme={setUiTheme}
          t={t}
          languageDropdownClassName={
            showNavigationMenu ? "hidden sm:inline-flex" : undefined
          }
          languageDropdownWrapperTestId={
            showNavigationMenu ? "header-language-dropdown-desktop" : undefined
          }
          themeToggleWrapperClassName={
            showNavigationMenu ? "hidden sm:flex" : undefined
          }
          themeToggleWrapperTestId={
            showNavigationMenu ? "header-theme-toggle-desktop" : undefined
          }
          rightExtras={renderCloudCredits("desktop")}
          trailingExtras={
            showNavigationMenu ? (
              <button
                type="button"
                className={`sm:hidden ${HEADER_ICON_BUTTON_CLASSNAME}`}
                onClick={() => setMobileMenuOpen(true)}
                aria-label="Open navigation menu"
                aria-expanded={mobileMenuOpen}
              >
                <Menu className="w-5 h-5" />
              </button>
            ) : null
          }
        >
          {mobileLeft ? (
            <div className="flex sm:hidden">{mobileLeft}</div>
          ) : null}
          {showNavigationMenu ? (
            <nav className="hidden sm:flex flex-1 items-center justify-left gap-1 overflow-x-auto whitespace-nowrap px-2 scrollbar-hide">
              {tabGroups.map((group: TabGroup) => {
                const primaryTab = group.tabs[0];
                const isActive = group.tabs.includes(tab);
                const Icon = group.icon;
                return (
                  <button
                    type="button"
                    key={group.label}
                    className={`inline-flex items-center justify-center gap-0 xl:gap-1.5 shrink-0 px-2.5 md:px-3 xl:px-4 py-2 text-[12px] bg-transparent border border-transparent cursor-pointer transition-all duration-300 rounded-full ${isActive
                        ? "text-accent font-bold bg-accent/15 shadow-[0_0_15px_rgba(var(--accent),0.18)] border-accent/40 ring-1 ring-inset ring-accent/20"
                        : "text-muted hover:text-txt hover:bg-bg-hover hover:border-border/50"
                      }`}
                    onClick={() => setTab(primaryTab)}
                    title={group.description}
                  >
                    <span
                      data-testid={`header-nav-icon-${primaryTab}`}
                      className="inline-flex md:hidden xl:inline-flex"
                    >
                      <Icon className="w-4 h-4" />
                    </span>
                    <span
                      data-testid={`header-nav-label-${primaryTab}`}
                      className="hidden md:inline"
                    >
                      {t(NAV_LABEL_I18N_KEY[group.label] ?? group.label)}
                    </span>
                  </button>
                );
              })}
            </nav>
          ) : null}
        </ShellHeaderControls>
      </header>

      {/* Mobile Menu Overlay */}
      {showNavigationMenu && mobileMenuOpen && (
        <div
          className="fixed inset-0 z-[140] sm:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
        >
          {/* Backdrop */}
          <button
            type="button"
            className="absolute inset-0 bg-black/30 backdrop-blur-sm w-full h-full border-0 cursor-pointer"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="Close navigation menu"
          />

          {/* Menu Panel */}
          <div className="absolute right-0 top-0 bottom-0 w-[280px] max-w-[85vw] bg-bg border-l border-border shadow-2xl animate-in slide-in-from-right duration-200 flex flex-col">
            <div className="flex flex-1 flex-col py-3 px-3">
              <div className="flex-1 overflow-y-auto">
                <div className="flex flex-col gap-1">
                  {tabGroups.map((group: TabGroup, index) => {
                    const primaryTab = group.tabs[0];
                    const isActive = group.tabs.includes(tab);
                    const Icon = group.icon;
                    return (
                      <button
                        key={group.label}
                        type="button"
                        className={`w-full flex items-center gap-3 px-3 py-3.5 border rounded-xl text-[14px] font-medium transition-all duration-300 cursor-pointer min-h-[48px] ${isActive
                            ? "border-accent/40 bg-accent/15 text-accent shadow-[0_0_15px_rgba(var(--accent),0.18)] ring-1 ring-inset ring-accent/20"
                            : "border-transparent bg-transparent text-txt hover:border-border/50 hover:bg-bg-hover"
                          }`}
                        style={{ animationDelay: `${index * 50}ms` }}
                        onClick={() => {
                          setTab(primaryTab);
                          setMobileMenuOpen(false);
                        }}
                      >
                        <span
                          className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${isActive ? "bg-accent/20" : "bg-bg-accent"
                            }`}
                        >
                          <Icon
                            className={`w-4 h-4 ${isActive ? "text-txt" : "text-muted"}`}
                          />
                        </span>
                        <div className="flex-1 text-left">
                          <div className="font-medium">
                            {t(NAV_LABEL_I18N_KEY[group.label] ?? group.label)}
                          </div>
                          {group.description && (
                            <div className="text-[11px] text-muted mt-0.5">
                              {group.description}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="mt-3 flex flex-col gap-3 border-t border-border/50 pt-3">
                {renderCloudCredits("mobile-menu")}
                <div className="flex items-center justify-end gap-2">
                  {renderMobileMenuLanguageDropdown()}
                  {renderMobileMenuThemeToggle()}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
