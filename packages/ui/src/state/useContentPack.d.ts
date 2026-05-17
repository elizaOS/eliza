/**
 * Content-pack lifecycle — load, activate, deactivate, persist, and rehydrate
 * VRM/world/branding bundles. Extracted from AppearanceSettingsSection so the
 * section component can stay presentational.
 *
 * Owns:
 * - `loadedPacks` state with on-unmount release.
 * - The active-pack baseline so deactivate restores prior identity/VRM state.
 * - First-mount rehydration of a persisted pack URL.
 * - The color-scheme cleanup callback that pack activation registers.
 */
import type { ResolvedContentPack } from "@elizaos/shared";
export interface UseContentPackResult {
    activePack: ResolvedContentPack | null;
    loadedPacks: ResolvedContentPack[];
    error: string | null;
    setError: (error: string | null) => void;
    canPickDirectory: boolean;
    activate: (pack: ResolvedContentPack) => void;
    deactivate: () => void;
    toggle: (pack: ResolvedContentPack) => void;
    loadFromUrl: (url: string) => Promise<void>;
    loadFromFiles: (files: File[]) => Promise<void>;
    isSafeContentPackUrl: (value: string) => boolean;
}
export declare function useContentPack(): UseContentPackResult;
//# sourceMappingURL=useContentPack.d.ts.map