import { type ReactNode } from "react";
import type { Conversation } from "../../api/client-types";
import { type ConnectorSendAsContext } from "../chat/connector-send-as";
import { type PageScope } from "./page-scoped-conversations";
export interface PageScopedChatPaneProps {
    scope: PageScope;
    pageId?: string;
    /** Override the conversation title (defaults to PAGE_SCOPE_DEFAULT_TITLE[scope]). */
    title?: string;
    /** Optional className for the outer wrapper. */
    className?: string;
    /**
     * Dynamic intro card override. When provided, replaces the static
     * PAGE_SCOPE_COPY[scope] intro text and can attach action buttons (used by
     * the Browser view to surface Agent Browser Bridge install buttons when the
     * extension is not yet connected).
     */
    introOverride?: {
        title?: string;
        body?: ReactNode;
        actions?: ReactNode;
    };
    /**
     * First-turn system addendum override — replaces PAGE_SCOPE_COPY[scope].systemAddendum
     * so the agent's first-turn grounding reflects current page state (e.g. the
     * Browser view tells the agent whether Agent Browser Bridge is connected).
     */
    systemAddendumOverride?: string;
    /** Override the composer placeholder text. */
    placeholderOverride?: string;
    /** Keep the intro visible above the thread, even after the chat has history. */
    persistentIntro?: boolean;
    /** Optional footer actions rendered inline with the Clear control. */
    footerActions?: ReactNode;
    /** Optional connector account context for page chat surfaces that can write through a connector. */
    connectorContext?: ConnectorSendAsContext | null;
    /**
     * Optional conversation adapter for surfaces that want to reuse the shared
     * sidebar chat UI but resolve a non-page-scoped conversation under the hood.
     */
    conversationAdapter?: {
        allowClear?: boolean;
        buildRoutingMetadata?: () => Record<string, unknown> | undefined;
        identityKey: string;
        onAfterSend?: () => void;
        onConversationResolved?: (conversation: Conversation) => void;
        resolveConversation: () => Promise<Conversation>;
    };
}
export declare function PageScopedChatPane({ scope, pageId, title, className, introOverride, systemAddendumOverride, placeholderOverride, persistentIntro, footerActions, connectorContext, conversationAdapter, }: PageScopedChatPaneProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=PageScopedChatPane.d.ts.map