import type * as React from "react";
import type { ChatMessageData, ChatMessageLabels, ChatVariant } from "./chat-types";
export interface ChatTranscriptProps {
    agentName?: string;
    carryoverMessages?: ChatMessageData[];
    carryoverOpacity?: number;
    labels?: ChatMessageLabels;
    messages: ChatMessageData[];
    onCopy?: (text: string) => void;
    onDelete?: (messageId: string) => void;
    onEdit?: (messageId: string, text: string) => Promise<boolean> | boolean;
    onSpeak?: (messageId: string, text: string) => void;
    renderMessageContent?: (message: ChatMessageData) => React.ReactNode;
    typingIndicator?: React.ReactNode;
    userMessagesOnRight?: boolean;
    variant?: ChatVariant;
}
export declare const ChatTranscript: React.MemoExoticComponent<({ agentName, carryoverMessages, carryoverOpacity, labels, messages, onCopy, onDelete, onEdit, onSpeak, renderMessageContent, typingIndicator, userMessagesOnRight, variant, }: ChatTranscriptProps) => import("react/jsx-runtime").JSX.Element>;
//# sourceMappingURL=chat-transcript.d.ts.map