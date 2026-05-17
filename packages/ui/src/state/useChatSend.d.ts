/**
 * Chat send callbacks — message sending and streaming operations.
 *
 * Extracted from useChatCallbacks.ts. Handles all message sending,
 * streaming, stop, retry, edit, clear, and queue management.
 */
import { type MutableRefObject } from "react";
import type { Conversation } from "../api";
import { type CodingAgentSession, type ConversationChannelType, type ConversationMessage, type ImageAttachment } from "../api";
import type { Tab } from "../navigation";
import { type LoadConversationMessagesResult } from "./internal";
export interface QueuedChatSend {
    rawInput: string;
    channelType: ConversationChannelType;
    conversationId?: string | null;
    images?: ImageAttachment[];
    metadata?: Record<string, unknown>;
    resolve: () => void;
    reject: (error: unknown) => void;
}
export interface UseChatSendDeps {
    t: (key: string) => string;
    uiLanguage: string;
    tab: Tab;
    activeConversationId: string | null;
    /** Stable ref whose .current mirrors the latest ptySessions array. */
    ptySessionsRef: MutableRefObject<CodingAgentSession[]>;
    setChatInput: (v: string) => void;
    setChatSending: (v: boolean) => void;
    setChatFirstTokenReceived: (v: boolean) => void;
    setChatLastUsage: (v: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        model: string | undefined;
        updatedAt: number;
    }) => void;
    setChatPendingImages: (v: ImageAttachment[]) => void;
    setConversations: (v: Conversation[] | ((prev: Conversation[]) => Conversation[])) => void;
    setActiveConversationId: (v: string | null) => void;
    setCompanionMessageCutoffTs: (v: number) => void;
    setConversationMessages: (v: ConversationMessage[] | ((prev: ConversationMessage[]) => ConversationMessage[])) => void;
    setUnreadConversations: (v: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
    setActionNotice: (text: string, tone: "success" | "error" | "info", ttlMs?: number, once?: boolean, busy?: boolean) => void;
    activeConversationIdRef: MutableRefObject<string | null>;
    chatInputRef: MutableRefObject<string>;
    chatPendingImagesRef: MutableRefObject<ImageAttachment[]>;
    conversationsRef: MutableRefObject<Conversation[]>;
    conversationMessagesRef: MutableRefObject<ConversationMessage[]>;
    chatAbortRef: MutableRefObject<AbortController | null>;
    chatSendBusyRef: MutableRefObject<boolean>;
    chatSendNonceRef: MutableRefObject<number>;
    loadConversations: () => Promise<Conversation[] | null>;
    loadConversationMessages: (convId: string) => Promise<LoadConversationMessagesResult>;
    elizaCloudEnabled: boolean;
    elizaCloudConnected: boolean;
    pollCloudCredits: () => Promise<boolean>;
}
export declare function useChatSend(deps: UseChatSendDeps): {
    chatSendQueueRef: import("react").RefObject<QueuedChatSend[]>;
    interruptActiveChatPipeline: () => void;
    appendLocalCommandTurn: (userText: string, assistantText: string) => void;
    tryHandlePrefixedChatCommand: (rawText: string) => Promise<{
        handled: boolean;
        rewrittenText?: string;
    }>;
    sendChatText: (rawInput: string, options?: {
        channelType?: ConversationChannelType;
        conversationId?: string | null;
        images?: ImageAttachment[];
        metadata?: Record<string, unknown>;
    }) => Promise<void>;
    handleChatSend: (channelType?: ConversationChannelType, options?: {
        metadata?: Record<string, unknown>;
    }) => Promise<void>;
    sendActionMessage: (text: string) => Promise<void>;
    handleChatStop: () => void;
    handleChatRetry: (assistantMsgId: string) => void;
    handleChatEdit: (messageId: string, text: string) => Promise<boolean>;
    handleChatClear: () => Promise<void>;
};
//# sourceMappingURL=useChatSend.d.ts.map