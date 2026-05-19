import type React from "react";
import { type ReactNode } from "react";
import { type PageScopedChatPaneProps } from "../pages/PageScopedChatPane.js";
import type { PageScope } from "../pages/page-scoped-conversations.js";
export declare const APP_WORKSPACE_CHROME_CHAT_STORAGE_KEY = "app-workspace-chrome:chat-collapsed";
export declare const APP_WORKSPACE_CHROME_CHAT_WIDTH_STORAGE_KEY = "app-workspace-chrome:chat-width";
interface AppWorkspaceChatChromeContextValue {
    collapseChat: () => void;
    openChat: () => void;
    isChatOpen: boolean;
}
export declare function useAppWorkspaceChatChrome(): AppWorkspaceChatChromeContextValue | null;
interface AppWorkspaceChatCollapseButtonProps {
    testId?: string;
}
export declare function AppWorkspaceChatCollapseButton({ testId, }: AppWorkspaceChatCollapseButtonProps): React.JSX.Element | null;
export interface AppWorkspaceChromeProps {
    /** Optional nav region rendered above the main pane. */
    nav?: ReactNode;
    /** Required main content area. */
    main: ReactNode;
    /**
     * Chat content for the right sidebar. When omitted a shared
     * `<ChatView variant="default" />` is rendered, unless `chatScope` is set.
     */
    chat?: ReactNode;
    /**
     * Page-scoped assistant context for workspace pages whose right rail should
     * explain and act within the current surface instead of the global chat.
     */
    chatScope?: PageScope;
    /**
     * Optional overrides forwarded into the shared page-scoped chat pane when
     * `chatScope` is provided.
     */
    pageScopedChatPaneProps?: Omit<PageScopedChatPaneProps, "scope" | "footerActions">;
    /**
     * Controlled: current collapsed state.
     * When provided, `onToggleChat` must also be provided.
     */
    chatCollapsed?: boolean;
    /**
     * Controlled: callback when the user toggles the sidebar.
     * Receives the next collapsed boolean.
     */
    onToggleChat?: (next: boolean) => void;
    /**
     * Uncontrolled: initial collapsed state.
     * Ignored when `chatCollapsed` is provided.
     * Defaults to the value persisted in localStorage, then `false`.
     */
    chatDefaultCollapsed?: boolean;
    /** Hide the default bottom-right collapse control when chat content owns it. */
    hideCollapseButton?: boolean;
    /** Disable the right chat rail for focused surfaces that own their own chat. */
    chatDisabled?: boolean;
    /** data-testid applied to the root element. */
    testId?: string;
}
/** Pure-layout chrome: main pane + collapsible right-side chat sidebar. */
export declare function AppWorkspaceChrome({ nav, main, chat, chatScope, pageScopedChatPaneProps, chatCollapsed: chatCollapsedProp, onToggleChat, chatDefaultCollapsed, hideCollapseButton, chatDisabled, testId, }: AppWorkspaceChromeProps): React.JSX.Element;
export {};
//# sourceMappingURL=AppWorkspaceChrome.d.ts.map