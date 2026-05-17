import type * as React from "react";
import type { Conversation } from "../../api/client-types-chat";
import type { TranslateFn } from "../../types";
export declare const ELIZA_SOURCE_SCOPE = "eliza";
export declare const TERMINAL_SOURCE_SCOPE = "terminal";
export declare const ALL_CONNECTORS_SOURCE_SCOPE = "__all_connectors__";
export declare const ALL_WORLDS_SCOPE = "__all_worlds__";
export interface InboxChatSidebarRow {
    avatarUrl?: string;
    canSend?: boolean;
    id: string;
    lastMessageAt: number;
    roomType?: string;
    source: string;
    transportSource?: string;
    title: string;
    worldId?: string;
    worldLabel: string;
}
export interface ConversationsSidebarRow {
    avatarUrl?: string;
    canSend?: boolean;
    id: string;
    kind: "conversation" | "inbox";
    sortKey: number;
    source?: string;
    sourceKey: string;
    transportSource?: string;
    title: string;
    updatedAtLabel: string;
    worldId?: string;
    worldKey: string | null;
    worldLabel?: string;
}
export interface ConversationsSidebarSection {
    count: number;
    key: string;
    label: string;
    rows: ConversationsSidebarRow[];
}
export interface ConversationsSidebarOption {
    count: number;
    icon?: React.ComponentType<{
        className?: string;
    }>;
    label: string;
    value: string;
}
export interface ConversationsSidebarModel {
    rows: ConversationsSidebarRow[];
    sections: ConversationsSidebarSection[];
    showWorldFilter: boolean;
    sourceOptions: ConversationsSidebarOption[];
    sourceScope: string;
    worldOptions: ConversationsSidebarOption[];
    worldScope: string;
}
export declare function buildConversationsSidebarModel({ conversations, inboxChats, searchQuery, sourceScope, t, worldScope, }: {
    conversations: Conversation[];
    inboxChats: InboxChatSidebarRow[];
    searchQuery: string;
    sourceScope: string;
    t: TranslateFn;
    worldScope: string;
}): ConversationsSidebarModel;
//# sourceMappingURL=conversation-sidebar-model.d.ts.map