/**
 * Global application state via React Context.
 *
 * Children access state and actions through the useApp() hook.
 */
import { type ReactNode } from "react";
export { type ActionNotice, AGENT_STATES, AGENT_TRANSFER_MIN_PASSWORD_LENGTH, type AppActions, AppContext, type AppContextValue, type AppState, applyUiTheme, asApiLikeError, type ChatTurnUsage, type CompanionHalfFramerateMode, type CompanionVrmPowerMode, computeStreamingDelta, formatSearchBullet, formatStartupErrorDetail, type GamePostMessageAuthPayload, getCompanionBackgroundUrl, getVrmBackgroundUrl, getVrmCount, getVrmPreviewUrl, getVrmTitle, getVrmUrl, LIFECYCLE_MESSAGES, type LifecycleAction, type LoadConversationMessagesResult, loadAvatarIndex, loadChatAvatarVisible, loadChatVoiceMuted, loadCompanionAnimateWhenHidden, loadCompanionHalfFramerateMode, loadCompanionVrmPowerMode, loadUiLanguage, loadUiShellMode, loadUiTheme, mergeStreamingText, type NavigationEventsApi, normalizeAvatarIndex, normalizeCompanionHalfFramerateMode, normalizeCompanionVrmPowerMode, normalizeCustomActionName, normalizeStreamComparisonText, normalizeUiShellMode, normalizeUiTheme, ONBOARDING_PERMISSION_LABELS, type OnboardingNextOptions, type OnboardingStep, parseAgentStartupDiagnostics, parseAgentStatusEvent, parseAgentStatusFromMainMenuResetPayload, parseConversationMessageEvent, parseCustomActionParams, parseProactiveMessageEvent, parseSlashCommandInput, parseStreamEventEnvelopeEvent, type ShellView, type SlashCommandInput, type StartupErrorReason, type StartupErrorState, type StartupPhase, saveAvatarIndex, saveChatAvatarVisible, saveChatVoiceMuted, saveCompanionAnimateWhenHidden, saveCompanionHalfFramerateMode, saveCompanionVrmPowerMode, saveUiLanguage, saveUiShellMode, saveUiTheme, shouldApplyFinalStreamText, type TabCommittedDetail, type TranslationContextValue, type UiShellMode, type UiTheme, useApp, VRM_COUNT, } from "./internal";
export { AGENT_READY_TIMEOUT_MS } from "./types";
export declare function AppProvider({ children, branding: brandingOverride, }: {
    children: ReactNode;
    branding?: Partial<import("../config/branding").BrandingConfig>;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=AppContext.d.ts.map