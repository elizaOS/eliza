import type { Conversation } from "../api";
export declare function isConversationRecord(value: unknown): value is Conversation;
export declare function isMainChatConversation(conversation: Pick<Conversation, "metadata" | "title"> | null | undefined): boolean;
export declare function filterMainChatConversations(conversations: Conversation[]): Conversation[];
export declare function normalizeConversationList(value: unknown): Conversation[];
//# sourceMappingURL=chat-conversation-guards.d.ts.map