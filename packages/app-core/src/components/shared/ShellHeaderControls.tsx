import { LanguageDropdown, ThemeToggle } from "@elizaos/app-core/components";
import type { UiLanguage } from "@elizaos/app-core/i18n";
import type { ShellView, UiTheme } from "@elizaos/app-core/state";
import {
  type LucideIcon,
  Monitor,
  Smartphone,
  UserRound,
  Users,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

export const HEADER_ICON_BUTTON_CLASSNAME =
  "inline-flex items-center justify-center w-11 h-11 min-w-[44px] min-h-[44px] border border-border/50 bg-bg/50 backdrop-blur-md cursor-pointer text-sm leading-none hover:border-accent hover:text-txt font-medium hover:-translate-y-0.5 transition-all duration-300 hover:shadow-[0_0_15px_rgba(var(--accent),0.5)] active:scale-95 rounded-xl text-txt shadow-sm";

type ShellHeaderTranslator = (key: string) => string;

const SHELL_MODE_MOBILE_BREAKPOINT = 768;

function useIsMobileShellViewport(): boolean {
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window !== "undefined"
      ? window.innerWidth <= SHELL_MODE_MOBILE_BREAKPOINT
      : false,
  );

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const mediaQuery = window.matchMedia(
      `(max-width: ${SHELL_MODE_MOBILE_BREAKPOINT}px)`,
    );
    const syncViewport = () => {
      setIsMobileViewport(mediaQuery.matches);
    };
    syncViewport();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", syncViewport);
      return () => mediaQuery.removeEventListener("change", syncViewport);
    }

    mediaQuery.addListener(syncViewport);
    return () => mediaQuery.removeListener(syncViewport);
  }, []);

  return isMobileViewport;
}

interface ShellHeaderControlsProps {
  activeShellView: ShellView;
  onShellViewChange: (view: ShellView) => void;
  uiLanguage: UiLanguage;
  setUiLanguage: (language: UiLanguage) => void;
  uiTheme: UiTheme;
  setUiTheme: (theme: UiTheme) => void;
  t: ShellHeaderTranslator;
  children?: ReactNode;
  rightExtras?: ReactNode;
  trailingExtras?: ReactNode;
  className?: string;
  controlsVariant?: "native" | "companion";
  languageDropdownClassName?: string;
  languageDropdownWrapperTestId?: string;
  themeToggleClassName?: string;
  themeToggleWrapperClassName?: string;
  themeToggleWrapperTestId?: string;
}

export function ShellHeaderControls({
  activeShellView,
  onShellViewChange,
  uiLanguage,
  setUiLanguage,
  uiTheme,
  setUiTheme,
  t,
  children,
  rightExtras,
  trailingExtras,
  className,
  controlsVariant = "native",
  languageDropdownClassName,
  languageDropdownWrapperTestId,
  themeToggleClassName,
  themeToggleWrapperClassName,
  themeToggleWrapperTestId,
}: ShellHeaderControlsProps) {
  const isMobileViewport = useIsMobileShellViewport();
  const shellOptions: Array<{
    view: ShellView;
    label: string;
    Icon: LucideIcon;
  }> = [
      {
        view: "companion",
        label: t("header.companionMode"),
        Icon: UserRound,
      },
      {
        view: "character",
        label: t("nav.character"),
        Icon: Users,
      },
      {
        view: "desktop",
        label: t("header.nativeMode"),
        Icon: isMobileViewport ? Smartphone : Monitor,
      },
    ];

  return (
    <div
      className={`flex min-w-0 items-center gap-3 w-full ${className ?? ""}`}
      data-no-camera-drag="true"
    >
      <div className="flex shrink-0 items-center">
        <fieldset
          className="inline-flex items-center gap-0.5 rounded-xl border border-border/60 bg-transparent p-0.5 shadow-sm dark:border-border dark:bg-transparent"
          data-testid="ui-shell-toggle"
          data-no-camera-drag="true"
          aria-label="Switch shell view"
        >
          <legend className="sr-only">Switch shell view</legend>
          {shellOptions.map(({ view, label, Icon }, index) => {
            const selected = activeShellView === view;
            const edgeClass =
              index === 0
                ? "rounded-l-xl rounded-r-none"
                : index === shellOptions.length - 1
                  ? "rounded-l-none rounded-r-xl"
                  : "rounded-none";
            return (
              <button
                key={view}
                type="button"
                onClick={() => onShellViewChange(view)}
                onPointerDown={(event) => event.stopPropagation()}
                className={`inline-flex h-11 min-h-[44px] min-w-[44px] items-center justify-center px-3 transition-all duration-200 ${edgeClass} ${selected
                    ? "border border-[#d8a108]/30 bg-bg/55 text-[#8a6500] shadow-sm dark:border-accent/25 dark:bg-bg/85 dark:text-[#f0b232]"
                    : "border border-transparent bg-transparent text-muted-strong hover:border-border/70 hover:bg-bg/85 hover:text-txt dark:text-muted dark:hover:border-border/60 dark:hover:bg-bg-hover/80 dark:hover:text-txt"
                  }`}
                aria-label={label}
                aria-pressed={selected}
                title={label}
                data-testid={`ui-shell-toggle-${view}`}
              >
                <Icon className="h-4 w-4" />
              </button>
            );
          })}
        </fieldset>
      </div>

      <div className="min-w-0 flex-1">{children}</div>

      <div
        className="flex shrink-0 items-center justify-end gap-2"
        data-testid="shell-header-right-controls"
        data-no-camera-drag="true"
      >
        {rightExtras}
        <div
          className={`shrink-0 ${languageDropdownClassName ?? ""}`}
          data-testid={languageDropdownWrapperTestId}
          data-no-camera-drag="true"
        >
          <LanguageDropdown
            uiLanguage={uiLanguage}
            setUiLanguage={setUiLanguage}
            t={t}
            variant={controlsVariant}
            triggerClassName="!h-11 !min-h-[44px] !min-w-[44px] !rounded-xl !px-3.5 sm:!px-3.5 leading-none"
          />
        </div>
        <div
          className={`shrink-0 ${themeToggleWrapperClassName ?? ""}`}
          data-testid={themeToggleWrapperTestId}
          data-no-camera-drag="true"
        >
          <ThemeToggle
            uiTheme={uiTheme}
            setUiTheme={setUiTheme}
            t={t}
            variant={controlsVariant}
            className={`!h-10 !w-10 !min-h-10 !min-w-10 ${themeToggleClassName ?? ""}`}
          />
        </div>
        {trailingExtras}
      </div>
    </div>
  );
}
