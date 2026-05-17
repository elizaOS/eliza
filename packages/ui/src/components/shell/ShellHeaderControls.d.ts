import type { ReactNode } from "react";
import type { UiLanguage } from "../../i18n";
import type { ShellView, UiTheme } from "../../state";
declare const SHELL_ICON_BUTTON_CLASSNAME = "inline-flex h-11 w-11 min-h-touch min-w-touch items-center justify-center rounded-sm border border-border/42 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_14px_32px_rgba(3,5,10,0.14)] ring-1 ring-inset ring-white/6  supports-[backdrop-filter]:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_62%,transparent),color-mix(in_srgb,var(--bg)_34%,transparent))] transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-accent/55 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_78%,transparent),color-mix(in_srgb,var(--bg-hover)_52%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_18px_36px_rgba(3,5,10,0.18)] active:scale-[0.98] disabled:active:scale-100 disabled:hover:border-border/42 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] disabled:hover:text-txt";
declare const HEADER_BUTTON_STYLE: {
    readonly clipPath: "none";
    readonly WebkitClipPath: "none";
    readonly touchAction: "manipulation";
};
export { HEADER_BUTTON_STYLE, SHELL_ICON_BUTTON_CLASSNAME as HEADER_ICON_BUTTON_CLASSNAME, };
type ShellHeaderTranslator = (key: string) => string;
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
export declare function ShellHeaderControls({ activeShellView, onShellViewChange, uiLanguage, setUiLanguage, uiTheme, setUiTheme, t, children, rightExtras, rightTrailingExtras, trailingExtras, className, showShellViewToggle, controlsVariant, languageDropdownClassName, languageDropdownWrapperTestId, themeToggleClassName, themeToggleWrapperClassName, themeToggleWrapperTestId, showCompanionControls, companionDesktopActionsLayout, chatAgentVoiceMuted, onToggleVoiceMute, onNewChat, onSave, isSaving, saveSuccess, }: ShellHeaderControlsProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=ShellHeaderControls.d.ts.map