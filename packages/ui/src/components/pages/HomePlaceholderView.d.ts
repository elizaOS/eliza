import type { ReactNode } from "react";
/**
 * Placeholder rendered when no installed app declares
 * `elizaos.app.mainTab: true` — i.e. the shell has no default landing
 * surface to mount. Phase 1 of the agent + app-core extraction plumbs
 * the discovery seam; until an app like `app-chat` claims the seam,
 * the shell still falls back to the legacy chat tab so this view is
 * not yet reachable in practice. It exists so subsequent phases can
 * drop the chat fallback without leaving the user staring at a blank
 * panel.
 */
export declare function HomePlaceholderView({ contentHeader, inModal, }?: {
    contentHeader?: ReactNode;
    inModal?: boolean;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=HomePlaceholderView.d.ts.map