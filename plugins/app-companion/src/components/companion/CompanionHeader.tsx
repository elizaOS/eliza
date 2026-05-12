import {
  Button,
  LanguageDropdown,
  ThemeToggle,
  type UiLanguage,
  type UiTheme,
  useMediaQuery,
} from "@elizaos/ui";
import {
  MessageCirclePlus,
  Monitor,
  PencilLine,
  Settings,
  Smartphone,
  Sparkles,
  UserRound,
  Volume2,
  VolumeX,
} from "lucide-react";
import { memo, type ReactNode } from "react";

const SHELL_MODE_MOBILE_BREAKPOINT = 639;
const SHELL_MODE_MOBILE_MEDIA_QUERY = `(max-width: ${SHELL_MODE_MOBILE_BREAKPOINT}px)`;

export type CompanionShellView = "companion" | "character" | "settings";

export interface CompanionHeaderProps {
  /** Which internal view is currently active. */
  activeView?: CompanionShellView;
  /** Exit companion overlay and navigate to chat / desktop. */
  onExitToDesktop: () => void;
  /** Switch to the character editor view within the companion overlay. */
  onExitToCharacter: () => void;
  /** Switch to companion-local settings within the overlay. */
  onOpenSettings?: () => void;
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
  onToggleEmotePicker?: () => void;
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
    onOpenSettings,
    onSwitchToCompanion,
    uiLanguage,
    setUiLanguage,
    uiTheme,
    setUiTheme,
    t,
    chatAgentVoiceMuted = false,
    onToggleVoiceMute,
    onNewChat,
    onToggleEmotePicker,
    rightExtras,
  } = props;

  const isMobileViewport = useMediaQuery(SHELL_MODE_MOBILE_MEDIA_QUERY);

  const voiceToggleLabel = chatAgentVoiceMuted
    ? t("companion.agentVoiceOff")
    : t("companion.agentVoiceOn");

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
      view: "settings" as const,
      label: "Companion settings",
      Icon: Settings,
      onClick:
        activeView === "settings" ? () => {} : (onOpenSettings ?? (() => {})),
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
                className="inline-flex items-center gap-0.5 rounded-xl border border-border/45 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_52%,transparent),color-mix(in_srgb,var(--bg)_34%,transparent))] p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_12px_28px_rgba(3,5,10,0.12)] ring-1 ring-inset ring-white/6 backdrop-blur-xl"
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
                      onPointerDown={(event: React.PointerEvent) =>
                        event.stopPropagation()
                      }
                      className={`h-11 min-h-touch min-w-touch px-3 transition-all duration-200 ${edgeClass} ${
                        selected
                          ? "border-[color:color-mix(in_srgb,var(--accent)_34%,var(--border))] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--accent)_20%,var(--card)),color-mix(in_srgb,var(--accent)_10%,var(--bg)))] text-[color:color-mix(in_srgb,var(--text-strong)_78%,var(--accent)_22%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_8px_20px_rgba(3,5,10,0.12)]"
                          : "border border-transparent bg-transparent text-muted-strong hover:border-border/60 hover:bg-bg-hover/80 hover:text-txt"
                      }`}
                      style={{
                        clipPath: "none",
                        WebkitClipPath: "none",
                        touchAction: "manipulation",
                      }}
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
                  {onToggleVoiceMute ? (
                    <Button
                      size="icon"
                      variant="outline"
                      aria-label={voiceToggleLabel}
                      aria-pressed={!chatAgentVoiceMuted}
                      title={voiceToggleLabel}
                      className="inline-flex h-11 w-11 min-h-touch min-w-touch items-center justify-center rounded-xl border border-border/42 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_14px_32px_rgba(3,5,10,0.14)] ring-1 ring-inset ring-white/6 backdrop-blur-xl supports-[backdrop-filter]:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_62%,transparent),color-mix(in_srgb,var(--bg)_34%,transparent))] transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-accent/55 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_78%,transparent),color-mix(in_srgb,var(--bg-hover)_52%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_18px_36px_rgba(3,5,10,0.18)] active:scale-[0.98] disabled:active:scale-100 disabled:hover:border-border/42 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] disabled:hover:text-txt pointer-events-auto text-sm leading-none"
                      onClick={onToggleVoiceMute}
                      onPointerDown={(event: React.PointerEvent) =>
                        event.stopPropagation()
                      }
                      style={{
                        clipPath: "none",
                        WebkitClipPath: "none",
                        touchAction: "manipulation",
                      }}
                      data-testid="companion-voice-toggle"
                      data-no-camera-drag="true"
                    >
                      {chatAgentVoiceMuted ? (
                        <VolumeX className="pointer-events-none h-4 w-4 shrink-0" />
                      ) : (
                        <Volume2 className="pointer-events-none h-4 w-4 shrink-0" />
                      )}
                    </Button>
                  ) : null}
                  {onToggleEmotePicker ? (
                    <Button
                      size="icon"
                      variant="outline"
                      aria-label="Open emotes"
                      title="Open emotes"
                      className="inline-flex h-11 w-11 min-h-touch min-w-touch items-center justify-center rounded-xl border border-border/42 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_14px_32px_rgba(3,5,10,0.14)] ring-1 ring-inset ring-white/6 backdrop-blur-xl supports-[backdrop-filter]:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_62%,transparent),color-mix(in_srgb,var(--bg)_34%,transparent))] transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-accent/55 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_78%,transparent),color-mix(in_srgb,var(--bg-hover)_52%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_18px_36px_rgba(3,5,10,0.18)] active:scale-[0.98] disabled:active:scale-100 disabled:hover:border-border/42 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] disabled:hover:text-txt pointer-events-auto text-sm leading-none"
                      onClick={onToggleEmotePicker}
                      onPointerDown={(event: React.PointerEvent) =>
                        event.stopPropagation()
                      }
                      style={{
                        clipPath: "none",
                        WebkitClipPath: "none",
                        touchAction: "manipulation",
                      }}
                      data-testid="companion-emote-toggle"
                      data-no-camera-drag="true"
                    >
                      <Sparkles className="pointer-events-none h-4 w-4 shrink-0" />
                    </Button>
                  ) : null}
                  {onNewChat ? (
                    <Button
                      size="icon"
                      variant="outline"
                      aria-label={t("companion.newChat")}
                      title={t("companion.newChat")}
                      className="inline-flex h-11 w-11 min-h-touch min-w-touch items-center justify-center rounded-xl border border-border/42 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_14px_32px_rgba(3,5,10,0.14)] ring-1 ring-inset ring-white/6 backdrop-blur-xl supports-[backdrop-filter]:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_62%,transparent),color-mix(in_srgb,var(--bg)_34%,transparent))] transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-accent/55 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_78%,transparent),color-mix(in_srgb,var(--bg-hover)_52%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_18px_36px_rgba(3,5,10,0.18)] active:scale-[0.98] disabled:active:scale-100 disabled:hover:border-border/42 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] disabled:hover:text-txt pointer-events-auto text-sm leading-none"
                      onClick={onNewChat}
                      onPointerDown={(event: React.PointerEvent) =>
                        event.stopPropagation()
                      }
                      style={{
                        clipPath: "none",
                        WebkitClipPath: "none",
                        touchAction: "manipulation",
                      }}
                      data-testid="companion-new-chat"
                      data-no-camera-drag="true"
                    >
                      <MessageCirclePlus className="pointer-events-none h-4 w-4 shrink-0" />
                    </Button>
                  ) : null}
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
                  triggerClassName="!h-11 !min-h-touch !min-w-touch !rounded-xl !px-3.5 sm:!px-3.5 leading-none"
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
