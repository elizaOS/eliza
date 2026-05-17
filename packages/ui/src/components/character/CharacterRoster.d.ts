import type { StylePreset } from "@elizaos/shared";
export declare const SLANT_CLIP = "polygon(32px 0, 100% 0, calc(100% - 32px) 100%, 0 100%)";
export declare const INSET_CLIP = "polygon(0px 0, 100% 0, calc(100% - 4px) 100%, -8px 100%)";
export type CharacterRosterEntry = {
    id: string;
    name: string;
    avatarIndex: number;
    previewUrl?: string;
    voicePresetId?: string;
    catchphrase?: string;
    greetingAnimation?: string;
    preset: StylePreset;
};
export declare function resolveRosterEntries(styles: readonly StylePreset[]): CharacterRosterEntry[];
export declare function createCustomPackRosterEntry(args: {
    id: string;
    name: string;
    previewUrl?: string;
    catchphrase?: string;
    voicePresetId?: string;
}): CharacterRosterEntry;
interface CharacterRosterProps {
    entries: CharacterRosterEntry[];
    selectedId: string | null;
    onSelect: (entry: CharacterRosterEntry) => void;
    /** "onboarding" always uses translucent white borders; "editor" uses theme-aware borders. */
    variant?: "onboarding" | "editor";
    testIdPrefix?: string;
}
export declare function CharacterRoster({ entries, selectedId, onSelect, variant, testIdPrefix, }: CharacterRosterProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=CharacterRoster.d.ts.map