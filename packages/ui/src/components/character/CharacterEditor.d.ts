import { type ReactNode } from "react";
export declare function CharacterEditor({ sceneOverlay, inModal: _inModal, onHeaderActionsChange, }?: {
    sceneOverlay?: boolean;
    inModal?: boolean;
    onHeaderActionsChange?: (actions: ReactNode | null) => void;
}): import("react/jsx-runtime").JSX.Element;
/**
 * Re-export as CharacterView so the upstream App.tsx import resolves here
 * when the Vite alias redirects ./CharacterView to this file.
 */
export { CharacterEditor as CharacterView };
//# sourceMappingURL=CharacterEditor.d.ts.map