import type * as React from "react";
import type { ChatMessageData, ChatMessageLabels } from "./chat-types";
export interface ChatMessageProps {
  agentName?: string;
  children?: React.ReactNode;
  isGrouped?: boolean;
  labels?: ChatMessageLabels;
  message: ChatMessageData;
  onCopy?: (text: string) => void;
  onDelete?: (messageId: string) => void;
  onEdit?: (messageId: string, text: string) => Promise<boolean> | boolean;
  onSpeak?: (messageId: string, text: string) => void;
  replyTarget?: ChatMessageData | null;
  userMessagesOnRight?: boolean;
}
export declare function getChatMessageAnchorId(messageId: string): string;
export declare const ChatMessage: React.MemoExoticComponent<
  ({
    message,
    isGrouped,
    agentName,
    children,
    labels,
    onCopy,
    onSpeak,
    onEdit,
    onDelete,
    replyTarget,
    userMessagesOnRight,
  }: ChatMessageProps) => import("react/jsx-runtime").JSX.Element
>;
//# sourceMappingURL=chat-message.d.ts.map
