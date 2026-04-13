import type { UiLanguage } from "@elizaos/app-core/i18n";
import type { UiTheme } from "@elizaos/app-core/state";
import { useMediaQuery } from "@elizaos/app-core/hooks";
import { Button } from "@elizaos/app-core";
import {
  MessageCirclePlus,
  Monitor,
  PencilLine,
  Smartphone,
  UserRound,
  Volume2,
  VolumeX,
} from "lucide-react";
import { memo, type ReactNode } from "react";
import {
  LanguageDropdown,
  LANGUAGE_DROPDOWN_TRIGGER_CLASSNAME,
} from "@elizaos/app-core/components/shared/LanguageDropdown";
import { ThemeToggle } from "@elizaos/app-core/components/shared/ThemeToggle";
import {
  HEADER_BUTTON_STYLE,
  SHELL_ICON_BUTTON_CLASSNAME,
  SHELL_SEGMENTED_CONTROL_CLASSNAME,
  SHELL_SEGMENT_ACTIVE_CLASSNAME,
  SHELL_SEGMENT_INACTIVE_CLASSNAME,
} from "./shell-control-styles";

const SHELL_MODE_MOBILE_BREAKPOINT = 639;
const SHELL_MODE_MOBILE_MEDIA_QUERY = `(max-width: ${SHELL_MODE_MOBILE_BREAKPOINT}px)`;

export type CompanionShellView = "companion" | "character";

export interface CompanionHeaderProps {
  /** Which internal view is currently active. */
  activeView?: CompanionShellView;
  /** Exit companion overlay and navigate to chat / desktop. */
  onExitToDesktop: () => void;
  /** Switch to the character editor view within the companion overlay. */
  onExitToCharacter: () => void;
  /** Switch back to the companion chat view within the overlay. */
  onSwitchToCompanion?: () => void;
  uiLanguage: UiLanguage;
  setUiLanguage: (language: UiLanguage) => void;
  uiTheme: UiTheme;
  setUiTheme: (theme: UiTheme) => void;
  t: (key: string) => string;
  chatAgentVoiceMuted?: boolean;
  onToggleVoiceMute?: () => void;
  onNewChat?: () => void;
  /** Shown in the shell header right cluster (e.g. inference / cloud alert). */
  rightExtras?: ReactNode;
}

export const CompanionHeader = memo(function CompanionHeader(
  props: CompanionHeaderProps,
) {
  const {
    activeView = "companion",
    onExitToDesktop,
    onExitToCharacter,
    onSwitchToCompanion,
    uiLanguage,
    setUiLanguage,
    uiTheme,
    setUiTheme,
    t,
    chatAgentVoiceMuted = false,
    onToggleVoiceMute,
    onNewChat,
    rightExtras,
  } = props;

  const isMobileViewport = useMediaQuery(SHELL_MODE_MOBILE_MEDIA_QUERY);

  const voiceToggleLabel = chatAgentVoiceMuted
    ? t("companion.agentVoiceOff")
    : t("companion.agentVoiceOn");

  const buttonClassName = `${SHELL_ICON_BUTTON_CLASSNAME} pointer-events-auto text-sm leading-none`;

  // Mode selector pill — companion & character switch views within the
  // overlay; desktop exits the overlay entirely.
  const shellOptions = [
    {
      view: "companion" as const,
      label: t("header.companionMode"),
      Icon: UserRound,
      onClick:
        activeView === "companion"
          ? () => {}
          : (onSwitchToCompanion ?? (() => {})),
    },
    {
      view: "character" as const,
      label: t("header.characterMode"),
      Icon: PencilLine,
      onClick: activeView === "character" ? () => {} : onExitToCharacter,
    },
    {
      view: "desktop" as const,
      label: t("header.nativeMode"),
      Icon: isMobileViewport ? Smartphone : Monitor,
      onClick: onExitToDesktop,
    },
  ];

  return (
    <header
      className="absolute inset-x-0 top-0 z-10 overflow-visible"
      data-no-camera-drag="true"
    >
      <div className="px-2 py-1">
        <div
          className="pointer-events-auto relative mx-auto w-full rounded-[20px] border border-transparent bg-transparent shadow-none ring-0 backdrop-blur-none bg-clip-padding transition-all sm:rounded-[22px] px-2.5 py-2 sm:px-4 sm:py-3"
          data-testid="companion-header-shell"
          data-no-camera-drag="true"
        >
          <div className="flex w-full items-center gap-2">
            {/* Left: mode selector pill */}
            <div
              className="flex shrink-0 items-center gap-2"
              data-no-camera-drag="true"
            >
              <fieldset
                className={SHELL_SEGMENTED_CONTROL_CLASSNAME}
                data-testid="companion-shell-toggle"
                data-no-camera-drag="true"
                aria-label={t("aria.switchShellView")}
              >
                <legend className="sr-only">{t("aria.switchShellView")}</legend>
                {shellOptions.map(({ view, label, Icon, onClick }, index) => {
                  const selected = view === activeView;
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
                      onClick={onClick}
                      onPointerDown={(event: React.PointerEvent) => event.stopPropagation()}
                      className={`h-11 min-h-touch min-w-touch px-3 transition-all duration-200 ${edgeClass} ${
                        selected
                          ? SHELL_SEGMENT_ACTIVE_CLASSNAME
                          : SHELL_SEGMENT_INACTIVE_CLASSNAME
                      }`}
                      style={HEADER_BUTTON_STYLE}
                      aria-label={label}
                      aria-pressed={selected}
                      title={label}
                      data-testid={`companion-shell-toggle-${view}`}
                      data-no-camera-drag="true"
                    >
                      <Icon className="pointer-events-none h-4 w-4" />
                    </Button>
                  );
                })}
              </fieldset>
            </div>

            {/* Center: voice + new chat */}
            <div className="flex-1 min-w-0">
              <div
                className="flex items-center justify-center"
                data-testid="companion-header-center-controls"
                data-no-camera-drag="true"
              >
                <div className="inline-flex items-center gap-2">
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label={voiceToggleLabel}
                    aria-pressed={!chatAgentVoiceMuted}
                    title={voiceToggleLabel}
                    className={buttonClassName}
                    onClick={onToggleVoiceMute}
                    onPointerDown={(event: React.PointerEvent) => event.stopPropagation()}
                    style={HEADER_BUTTON_STYLE}
                    data-no-camera-drag="true"
                  >
                    {chatAgentVoiceMuted ? (
                      <VolumeX className="pointer-events-none h-4 w-4 shrink-0" />
                    ) : (
                      <Volume2 className="pointer-events-none h-4 w-4 shrink-0" />
                    )}
                  </Button>
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label={t("companion.newChat")}
                    title={t("companion.newChat")}
                    className={buttonClassName}
                    onClick={onNewChat}
                    onPointerDown={(event: React.PointerEvent) => event.stopPropagation()}
                    style={HEADER_BUTTON_STYLE}
                    data-no-camera-drag="true"
                  >
                    <MessageCirclePlus className="pointer-events-none h-4 w-4 shrink-0" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Right: extras + language + theme */}
            <div
              className="flex min-w-0 shrink-0 items-center justify-end gap-2 overflow-visible"
              data-no-camera-drag="true"
            >
              {rightExtras}
              <div className="shrink-0" data-no-camera-drag="true">
                <LanguageDropdown
                  uiLanguage={uiLanguage}
                  setUiLanguage={setUiLanguage}
                  t={t}
                  variant="companion"
                  triggerClassName={LANGUAGE_DROPDOWN_TRIGGER_CLASSNAME}
                />
              </div>
              <div className="shrink-0" data-no-camera-drag="true">
                <ThemeToggle
                  uiTheme={uiTheme}
                  setUiTheme={setUiTheme}
                  t={t}
                  variant="companion"
                  className="!h-11 !w-11 !min-h-touch !min-w-touch"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
});
