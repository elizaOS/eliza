import type { ReactNode } from "react";
interface HeaderProps {
    mobileLeft?: ReactNode;
    pageRightExtras?: ReactNode;
    transparent?: boolean;
    hideCloudCredits?: boolean;
    tasksEventsPanelOpen?: boolean;
    onToggleTasksPanel?: () => void;
    /**
     * When true, the mobile bottom nav bar is hidden. Used on the chat tab to
     * create a chat-first experience with no nav visible by default — the nav
     * reappears when the user navigates to any other tab.
     */
    hideNav?: boolean;
}
export declare function Header({ mobileLeft, pageRightExtras, transparent: _transparent, hideCloudCredits, tasksEventsPanelOpen, onToggleTasksPanel, hideNav, }: HeaderProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=Header.d.ts.map