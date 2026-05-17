import { type UiLanguage } from "../i18n";
import type { Tab } from "../navigation";
import type { CompanionHalfFramerateMode, CompanionVrmPowerMode, OnboardingStep } from "./types";
import type { UiShellMode, UiTheme } from "./ui-preferences";
export type { UiTheme } from "./ui-preferences";
declare function normalizeUiTheme(value: unknown): UiTheme;
export { normalizeUiTheme };
export declare function loadUiTheme(): UiTheme;
export declare function saveUiTheme(theme: UiTheme): void;
export declare function normalizeCompanionVrmPowerMode(value: unknown): CompanionVrmPowerMode;
/**
 * Persisted 3D companion power preference. Migrates legacy boolean keys once.
 */
export declare function loadCompanionVrmPowerMode(): CompanionVrmPowerMode;
export declare function saveCompanionVrmPowerMode(mode: CompanionVrmPowerMode): void;
/** When true, keep the VRM loop running when the document is hidden; 3D environment is hidden. */
export declare function loadCompanionAnimateWhenHidden(): boolean;
export declare function saveCompanionAnimateWhenHidden(enabled: boolean): void;
export declare function normalizeCompanionHalfFramerateMode(raw: string | null | undefined): CompanionHalfFramerateMode;
export declare function loadCompanionHalfFramerateMode(): CompanionHalfFramerateMode;
export declare function saveCompanionHalfFramerateMode(mode: CompanionHalfFramerateMode): void;
/**
 * Apply the theme to the document root.
 * Sets both `data-theme` attribute and `.dark` class so both CSS selectors
 * in base.css (`[data-theme="dark"]` and `.dark`) are satisfied.
 */
export declare function applyUiTheme(theme: UiTheme): void;
export declare function loadPersistedOnboardingStep(): OnboardingStep | null;
export declare function saveOnboardingStep(step: OnboardingStep): void;
export declare function clearPersistedOnboardingStep(): void;
export declare function loadPersistedOnboardingComplete(): boolean;
export declare function savePersistedOnboardingComplete(complete: boolean): void;
export declare function loadPersistedActivePackId(): string | null;
export declare function savePersistedActivePackId(packId: string | null): void;
export declare function loadPersistedActivePackUrl(): string | null;
export declare function savePersistedActivePackUrl(packUrl: string | null): void;
export declare function loadUiLanguage(): UiLanguage;
export declare function saveUiLanguage(language: UiLanguage): void;
declare function normalizeUiShellMode(mode: unknown): UiShellMode;
export { normalizeUiShellMode };
export declare function loadUiShellMode(): UiShellMode;
export declare function saveUiShellMode(mode: UiShellMode): void;
export declare function loadLastNativeTab(): Tab;
export declare function saveLastNativeTab(tab: Tab): void;
export declare function loadAvatarIndex(): number;
export declare function saveAvatarIndex(index: number): void;
export declare function clearAvatarIndex(): void;
export declare function loadFavoriteApps(): string[];
export declare function saveFavoriteApps(apps: string[]): void;
/**
 * Hydrate the favorites list from the server-side persisted store
 * (config.ui.favoriteApps), falling back to the local cache on failure.
 * Mirrors the result back into localStorage so the next boot is fast.
 */
export declare function fetchServerFavoriteApps(): Promise<string[] | null>;
/**
 * Replace the server-persisted favorites list. Used when the UI commits
 * a bulk reorder/edit. Best-effort: returns null on failure.
 */
export declare function replaceServerFavoriteApps(favoriteAppNames: string[]): Promise<string[] | null>;
/**
 * Toggle a single app's favorite state on the server. Returns the updated
 * list, or `null` if the request failed (caller should keep optimistic UI
 * state). Local cache is updated on success.
 */
export declare function toggleServerFavoriteApp(appName: string, isFavorite: boolean): Promise<string[] | null>;
/** Cap on persisted recency list. Older entries are evicted. */
export declare const RECENT_APPS_MAX = 10;
export declare function loadRecentApps(): string[];
export declare function saveRecentApps(apps: string[]): void;
export declare function loadWalletEnabled(): boolean;
export declare function saveWalletEnabled(value: boolean): void;
type ContinuousChatModeValue = "off" | "vad-gated" | "always-on";
export declare function loadContinuousChatMode(): ContinuousChatModeValue;
export declare function saveContinuousChatMode(mode: ContinuousChatModeValue): void;
export declare function loadVoicePrefixDone(): boolean;
export declare function saveVoicePrefixDone(done: boolean): void;
export declare function loadBrowserEnabled(): boolean;
export declare function saveBrowserEnabled(value: boolean): void;
export declare function loadComputerUseEnabled(): boolean;
export declare function saveComputerUseEnabled(value: boolean): void;
export declare function loadChatAvatarVisible(): boolean;
export declare function loadChatVoiceMuted(): boolean;
export declare function saveChatAvatarVisible(value: boolean): void;
export declare function saveChatVoiceMuted(value: boolean): void;
export declare function loadActiveConversationId(): string | null;
export declare function saveActiveConversationId(value: string | null): void;
export declare function loadCompanionMessageCutoffTs(): number;
export declare function saveCompanionMessageCutoffTs(value: number): void;
export interface PersistedActiveServer {
    /** Stable identifier for the selected server target. */
    id: string;
    /** Server category as seen by the client startup flow. */
    kind: "local" | "cloud" | "remote";
    /** Human-readable label for future chooser/history UI. */
    label: string;
    /** Reachable API base for remote/cloud servers. */
    apiBase?: string;
    /** Optional auth/access token for the selected server. */
    accessToken?: string;
}
export declare function createPersistedActiveServer(args: {
    kind: PersistedActiveServer["kind"];
    apiBase?: string;
    accessToken?: string;
    label?: string;
}): PersistedActiveServer;
export declare function loadPersistedActiveServer(): PersistedActiveServer | null;
export declare function savePersistedActiveServer(server: PersistedActiveServer): void;
export declare function clearPersistedActiveServer(): void;
//# sourceMappingURL=persistence.d.ts.map