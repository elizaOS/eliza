/**
 * Content pack application.
 *
 * Takes a ResolvedContentPack and applies its assets to the app state.
 * This is called from the splash page after the user selects a pack.
 */
import type { ContentPackColorScheme, ResolvedContentPack } from "@elizaos/shared";
/** Minimal state setters needed to apply a content pack. */
export interface ContentPackApplyDeps {
    setCustomVrmUrl: (url: string) => void;
    setCustomVrmPreviewUrl: (url: string) => void;
    setCustomBackgroundUrl: (url: string) => void;
    setCustomWorldUrl: (url: string) => void;
    setSelectedVrmIndex: (index: number) => void;
    setOnboardingName: (name: string) => void;
    setOnboardingStyle: (style: string) => void;
    setCustomCatchphrase: (phrase: string) => void;
    setCustomVoicePresetId: (id: string) => void;
}
/**
 * Apply a content pack to the app state.
 * Call this on the splash page after the user selects a pack.
 */
export declare function applyContentPack(pack: ResolvedContentPack, deps: ContentPackApplyDeps): void;
/**
 * Apply a content pack's color scheme as CSS custom properties on the
 * document root. Returns a cleanup function that removes them.
 *
 * If the pack includes a full ThemeDefinition (via `theme` field),
 * it takes precedence over the narrow colorScheme.
 */
export declare function applyColorScheme(scheme: ContentPackColorScheme | undefined, pack?: ResolvedContentPack): () => void;
//# sourceMappingURL=apply-pack.d.ts.map