/**
 * Apps page — single-surface app browser with optional full-screen game mode.
 */
import type React from "react";
type AppsPageViewRenderer = () => React.ReactElement;
export declare function AppsPageView({ inModal, appsView: AppsViewRenderer, gameView: GameViewRenderer, }?: {
    inModal?: boolean;
    appsView?: AppsPageViewRenderer;
    gameView?: AppsPageViewRenderer;
}): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=AppsPageView.d.ts.map