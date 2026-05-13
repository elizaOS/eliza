import {
  Check,
  Loader2,
  type LucideIcon,
  MessageCirclePlus,
  Monitor,
  PencilLine,
  Save,
  Smartphone,
  UserRound,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMediaQuery } from "../../hooks";
import type { UiLanguage } from "../../i18n";
import type { ShellView, UiTheme } from "../../state";
import {
  LANGUAGE_DROPDOWN_TRIGGER_CLASSNAME,
  LanguageDropdown,
} from "../shared/LanguageDropdown";
import { ThemeToggle } from "../shared/ThemeToggle";
import { Button } from "../ui/button";

const SHELL_CONTROL_BASE_CLASSNAME =
  "border border-border/42 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_14px_32px_rgba(3,5,10,0.14)] ring-1 ring-inset ring-white/6 backdrop-blur-xl supports-[backdrop-filter]:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_62%,transparent),color-mix(in_srgb,var(--bg)_34%,transparent))] transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-accent/55 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_78%,transparent),color-mix(in_srgb,var(--bg-hover)_52%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_18px_36px_rgba(3,5,10,0.18)] active:scale-[0.98] disabled:active:scale-100 disabled:hover:border-border/42 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] disabled:hover:text-txt";

const SHELL_ICON_BUTTON_CLASSNAME = `inline-flex h-11 w-11 min-h-touch min-w-touch items-center justify-center rounded-xl ${SHELL_CONTROL_BASE_CLASSNAME}`;

const SHELL_EXPANDED_BUTTON_CLASSNAME = `inline-flex h-11 min-h-touch min-w-touch items-center justify-center rounded-xl px-3.5 py-0 ${SHELL_CONTROL_BASE_CLASSNAME}`;

const SHELL_SEGMENTED_CONTROL_CLASSNAME =
  "inline-flex items-center gap-0.5 rounded-xl border border-border/45 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_52%,transparent),color-mix(in_srgb,var(--bg)_34%,transparent))] p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_12px_28px_rgba(3,5,10,0.12)] ring-1 ring-inset ring-white/6 backdrop-blur-xl";

const SHELL_SEGMENT_ACTIVE_CLASSNAME =
  "border-[color:color-mix(in_srgb,var(--accent)_34%,var(--border))] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--accent)_20%,var(--card)),color-mix(in_srgb,var(--accent)_10%,var(--bg)))] text-[color:color-mix(in_srgb,var(--text-strong)_78%,var(--accent)_22%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_8px_20px_rgba(3,5,10,0.12)]";

const SHELL_SEGMENT_INACTIVE_CLASSNAME =
  "border border-transparent bg-transparent text-muted-strong hover:border-border/60 hover:bg-bg-hover/80 hover:text-txt";

const HEADER_BUTTON_STYLE = {
  clipPath: "none",
  WebkitClipPath: "none",
  touchAction: "manipulation",
} as const;

export {
  HEADER_BUTTON_STYLE,
  SHELL_ICON_BUTTON_CLASSNAME as HEADER_ICON_BUTTON_CLASSNAME,
};

type ShellHeaderTranslator = (key: string) => string;

const SHELL_MODE_MOBILE_BREAKPOINT = 639;
const SHELL_MODE_MOBILE_MEDIA_QUERY = `(max-width: ${SHELL_MODE_MOBILE_BREAKPOINT}px)`;

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
  rightTrailingExtras?: ReactNode;
  trailingExtras?: ReactNode;
  className?: string;
  controlsVariant?: "native" | "companion";
  languageDropdownClassName?: string;
  languageDropdownWrapperTestId?: string;
  themeToggleClassName?: string;
  themeToggleWrapperClassName?: string;
  themeToggleWrapperTestId?: string;
  /** Hide the segmented shell-view toggle (pill). Outside the companion overlay the pill is not shown. */
  showShellViewToggle?: boolean;
  /** Show Voice + New Chat buttons (companion & character editor views). */
  showCompanionControls?: boolean;
  companionDesktopActionsLayout?: "centered" | "split";
  chatAgentVoiceMuted?: boolean;
  onToggleVoiceMute?: () => void;
  onNewChat?: () => void;
  onSave?: () => void;
  isSaving?: boolean;
  saveSuccess?: boolean;
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
  rightTrailingExtras,
  trailingExtras,
  className,
  showShellViewToggle = true,
  controlsVariant = "native",
  languageDropdownClassName,
  languageDropdownWrapperTestId,
  themeToggleClassName,
  themeToggleWrapperClassName,
  themeToggleWrapperTestId,
  showCompanionControls,
  companionDesktopActionsLayout = "centered",
  chatAgentVoiceMuted = false,
  onToggleVoiceMute,
  onNewChat,
  onSave,
  isSaving = false,
  saveSuccess = false,
}: ShellHeaderControlsProps) {
  const isMobileViewport = useMediaQuery(SHELL_MODE_MOBILE_MEDIA_QUERY);
  const shouldSplitCompanionDesktopActions =
    !isMobileViewport &&
    Boolean(showCompanionControls) &&
    companionDesktopActionsLayout === "split";
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
      label: t("header.characterMode"),
      Icon: PencilLine,
    },
    {
      view: "desktop",
      label: t("header.nativeMode"),
      Icon: isMobileViewport ? Smartphone : Monitor,
    },
  ];
  const voiceToggleLabel = chatAgentVoiceMuted
    ? t("aria.agentVoiceOff")
    : t("aria.agentVoiceOn");
  const compactCompanionActionClassName = `${SHELL_ICON_BUTTON_CLASSNAME} pointer-events-auto text-sm leading-none`;
  const expandedCompanionActionClassName = `${SHELL_EXPANDED_BUTTON_CLASSNAME} !w-auto gap-1.5 !px-3.5 justify-center text-sm leading-none`;

  const renderVoiceButton = (iconOnly: boolean) =>
    onToggleVoiceMute ? (
      <Button
        size="icon"
        variant="outline"
        aria-label={voiceToggleLabel}
        aria-pressed={!chatAgentVoiceMuted}
        title={voiceToggleLabel}
        className={
          iconOnly
            ? compactCompanionActionClassName
            : expandedCompanionActionClassName
        }
        onClick={onToggleVoiceMute}
        onPointerDown={(event) => event.stopPropagation()}
        style={HEADER_BUTTON_STYLE}
        data-no-camera-drag="true"
      >
        {chatAgentVoiceMuted ? (
          <VolumeX className="pointer-events-none h-4 w-4 shrink-0" />
        ) : (
          <Volume2 className="pointer-events-none h-4 w-4 shrink-0" />
        )}
        {iconOnly ? null : (
          <span className="pointer-events-none">{t("common.voice")}</span>
        )}
      </Button>
    ) : null;

  const renderNewChatButton = (iconOnly: boolean) => (
    <Button
      size="icon"
      variant="outline"
      aria-label={t("common.newChat")}
      title={t("common.newChat")}
      className={
        iconOnly
          ? compactCompanionActionClassName
          : expandedCompanionActionClassName
      }
      onClick={onNewChat}
      onPointerDown={(event) => event.stopPropagation()}
      style={HEADER_BUTTON_STYLE}
      data-no-camera-drag="true"
    >
      <MessageCirclePlus className="pointer-events-none h-4 w-4 shrink-0" />
      {iconOnly ? null : (
        <span className="pointer-events-none">{t("common.newChat")}</span>
      )}
    </Button>
  );

  const renderSaveButton = (iconOnly: boolean) => (
    <Button
      size="icon"
      variant="outline"
      aria-label={t("common.save")}
      title={t("common.save")}
      className={
        iconOnly
          ? compactCompanionActionClassName
          : expandedCompanionActionClassName
      }
      onClick={onSave}
      disabled={isSaving}
      onPointerDown={(event) => event.stopPropagation()}
      style={HEADER_BUTTON_STYLE}
      data-no-camera-drag="true"
    >
      {isSaving ? (
        <Loader2 className="pointer-events-none h-4 w-4 shrink-0 animate-spin" />
      ) : saveSuccess ? (
        <Check className="pointer-events-none h-4 w-4 shrink-0 text-status-success" />
      ) : (
        <Save className="pointer-events-none h-4 w-4 shrink-0" />
      )}
      {iconOnly ? null : (
        <span className="pointer-events-none">
          {isSaving
            ? t("charactereditor.Saving")
            : saveSuccess
              ? t("common.saved")
              : t("common.save")}
        </span>
      )}
    </Button>
  );

  /** Render the appropriate action button — Save for character, New Chat for companion */
  const renderActionButton = (iconOnly: boolean) => {
    if (onSave) return renderSaveButton(iconOnly);
    if (onNewChat) return renderNewChatButton(iconOnly);
    return null;
  };

  return (
    <div
      className={`min-w-0 w-full overflow-visible flex items-center ${className ?? ""}`}
      data-no-camera-drag="true"
    >
      {/* Left: shell view toggle (hidden outside companion overlay) */}
      <div className="flex shrink-0 items-center gap-2">
        {showShellViewToggle && (
          <fieldset
            className={SHELL_SEGMENTED_CONTROL_CLASSNAME}
            data-testid="ui-shell-toggle"
            data-no-camera-drag="true"
            aria-label={t("aria.switchShellView")}
          >
            <legend className="sr-only">{t("aria.switchShellView")}</legend>
            {shellOptions.map(({ view, label, Icon }, index) => {
              const selected = activeShellView === view;
              const edgeClass =
                index === 0
                  ? "rounded-l-xl rounded-r-none"
                  : index === shellOptions.length - 1
                    ? "rounded-l-none rounded-r-xl"
                    : "rounded-none";
              return (
                <Button
                  key={view}
                  size="icon"
                  onClick={() => onShellViewChange(view)}
                  onPointerDown={(event) => event.stopPropagation()}
                  className={`h-11 min-h-touch min-w-touch px-3 transition-all duration-200 ${edgeClass} ${
                    selected
                      ? SHELL_SEGMENT_ACTIVE_CLASSNAME
                      : SHELL_SEGMENT_INACTIVE_CLASSNAME
                  }`}
                  style={HEADER_BUTTON_STYLE}
                  aria-label={label}
                  aria-pressed={selected}
                  title={label}
                  data-testid={`ui-shell-toggle-${view}`}
                >
                  <Icon className="pointer-events-none h-4 w-4" />
                </Button>
              );
            })}
          </fieldset>
        )}
        {shouldSplitCompanionDesktopActions ? (
          <div
            className="flex shrink-0 items-center"
            data-testid="companion-header-desktop-voice"
            data-no-camera-drag="true"
          >
            {renderVoiceButton(true)}
          </div>
        ) : null}
      </div>

      {/* Center: children or companion controls */}
      <div className="flex-1 min-w-0">
        {showCompanionControls ? (
          shouldSplitCompanionDesktopActions ? null : (
            <div
              className="flex items-center justify-center"
              data-testid="companion-header-chat-controls"
              data-no-camera-drag="true"
            >
              <div className="inline-flex items-center gap-2">
                {renderVoiceButton(isMobileViewport)}
                {renderActionButton(isMobileViewport)}
              </div>
            </div>
          )
        ) : (
          children
        )}
      </div>

      {/* Right: controls */}
      <div
        className="flex min-w-0 shrink-0 items-center justify-end gap-2 overflow-visible"
        data-testid="shell-header-right-controls"
        data-no-camera-drag="true"
      >
        {rightExtras}
        {shouldSplitCompanionDesktopActions ? (
          <div
            className="flex shrink-0 items-center"
            data-testid="companion-header-desktop-new-chat"
            data-no-camera-drag="true"
          >
            {renderActionButton(true)}
          </div>
        ) : null}
        {/* Cloud status / trailing chrome: main (desktop) shell only — not companion or character editor */}
        {activeShellView === "desktop" ? rightTrailingExtras : null}
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
            triggerClassName={LANGUAGE_DROPDOWN_TRIGGER_CLASSNAME}
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
            className={`!h-11 !w-11 !min-h-touch !min-w-touch ${themeToggleClassName ?? ""}`}
          />
        </div>
        {trailingExtras}
      </div>
    </div>
  );
}
