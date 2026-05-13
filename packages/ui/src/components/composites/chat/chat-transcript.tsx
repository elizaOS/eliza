import type * as React from "react";

import { memo, useMemo } from "react";

import { ChatBubble } from "./chat-bubble";
import { ChatMessage } from "./chat-message";
import type {
  ChatMessageData,
  ChatMessageLabels,
  ChatVariant,
} from "./chat-types";

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

function renderTranscriptMessageContent(
  message: ChatMessageData,
  renderMessageContent?: (message: ChatMessageData) => React.ReactNode,
) {
  return renderMessageContent?.(message) ?? message.text;
}

const LEGACY_REPLY_REFERENCE_RE =
  /^Referencing MessageID ([0-9a-f-]{36})(?: \([^)]{0,512}\))?(?: in channel [^\n]{0,512})?(?: in guild [^\n]{0,512})?$/i;

function normalizeTranscriptMessage(message: ChatMessageData): ChatMessageData {
  const rawText = typeof message.text === "string" ? message.text : "";
  const lines = rawText.split(/\r?\n/);
  let extractedReplyToMessageId =
    typeof message.replyToMessageId === "string" &&
    message.replyToMessageId.trim().length > 0
      ? message.replyToMessageId.trim()
      : "";
  let removedLegacyReference = false;

  const cleanedLines = lines.filter((line) => {
    const trimmed = line.trim();
    // Clamp length before regex to prevent worst-case backtracking on
    // pathological inputs.
    if (trimmed.length > 4096) {
      return true;
    }
    const match = trimmed.match(LEGACY_REPLY_REFERENCE_RE);
    if (!match) {
      return true;
    }
    if (!extractedReplyToMessageId) {
      extractedReplyToMessageId = match[1];
    }
    removedLegacyReference = true;
    return false;
  });

  const cleanedText = removedLegacyReference
    ? cleanedLines
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd()
    : rawText;

  if (
    cleanedText === rawText &&
    extractedReplyToMessageId === (message.replyToMessageId ?? "")
  ) {
    return message;
  }

  return {
    ...message,
    text: cleanedText,
    ...(extractedReplyToMessageId
      ? { replyToMessageId: extractedReplyToMessageId }
      : {}),
  };
}

function getMessageGroupingKey(message: ChatMessageData): string {
  if (message.role !== "user") {
    return message.role;
  }

  const source = message.source?.trim().toLowerCase() ?? "";
  const senderName = message.from?.trim().toLowerCase() ?? "";
  const senderHandle = message.fromUserName?.trim().toLowerCase() ?? "";
  const avatarUrl = message.avatarUrl?.trim() ?? "";

  if (!source && !senderName && !senderHandle && !avatarUrl) {
    return "user";
  }

  return `user:${source}|${senderName}|${senderHandle}|${avatarUrl}`;
}

export const ChatTranscript = memo(function ChatTranscript({
  agentName = "Agent",
  carryoverMessages = [],
  carryoverOpacity = 1,
  labels,
  messages,
  onCopy,
  onDelete,
  onEdit,
  onSpeak,
  renderMessageContent,
  typingIndicator,
  userMessagesOnRight = true,
  variant = "default",
}: ChatTranscriptProps) {
  const normalizedMessages = useMemo(
    () => messages.map(normalizeTranscriptMessage),
    [messages],
  );

  if (variant === "game-modal") {
    return (
      <div className="flex min-h-full w-full flex-col justify-end gap-4 px-1 py-4">
        {carryoverMessages.map((message) => {
          const isUser = message.role === "user";
          return (
            <div
              key={`carryover-${message.id}`}
              data-testid="companion-message-row"
              data-companion-carryover="true"
              className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}
              style={{ opacity: carryoverOpacity }}
            >
              <ChatBubble
                tone={isUser ? "user" : "assistant"}
                className={`max-w-[min(85%,24rem)] rounded-2xl px-4 py-3 text-[15px] leading-relaxed backdrop-blur-md ${
                  isUser ? "rounded-br-sm" : "rounded-bl-sm"
                }`}
              >
                <div
                  className="break-words"
                  style={{ fontFamily: "var(--font-chat)" }}
                >
                  {renderTranscriptMessageContent(
                    message,
                    renderMessageContent,
                  )}
                </div>
              </ChatBubble>
            </div>
          );
        })}
        {normalizedMessages.map((message) => {
          const isUser = message.role === "user";
          return (
            <div
              key={message.id}
              data-testid="companion-message-row"
              className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}
            >
              <ChatBubble
                tone={isUser ? "user" : "assistant"}
                className={`max-w-[min(85%,24rem)] rounded-2xl px-4 py-3 text-[15px] leading-relaxed backdrop-blur-md ${
                  isUser ? "rounded-br-sm" : "rounded-bl-sm"
                }`}
              >
                <div
                  className="break-words"
                  style={{ fontFamily: "var(--font-chat)" }}
                >
                  {renderTranscriptMessageContent(
                    message,
                    renderMessageContent,
                  )}
                </div>
              </ChatBubble>
            </div>
          );
        })}
        {typingIndicator}
      </div>
    );
  }

  return (
    <div className="w-full space-y-1.5">
      {normalizedMessages.map((message, index) => {
        const replyTarget =
          typeof message.replyToMessageId === "string" &&
          message.replyToMessageId.length > 0
            ? (normalizedMessages.find(
                (candidate) => candidate.id === message.replyToMessageId,
              ) ?? null)
            : null;
        const previousMessage =
          index > 0 ? normalizedMessages[index - 1] : null;
        const isGrouped =
          previousMessage?.role === message.role &&
          previousMessage != null &&
          getMessageGroupingKey(previousMessage) ===
            getMessageGroupingKey(message);

        return (
          <ChatMessage
            key={message.id}
            message={message}
            isGrouped={isGrouped}
            agentName={agentName}
            labels={labels}
            onCopy={onCopy}
            onDelete={onDelete}
            onEdit={onEdit}
            onSpeak={onSpeak}
            replyTarget={replyTarget}
            userMessagesOnRight={userMessagesOnRight}
          >
            {renderTranscriptMessageContent(message, renderMessageContent)}
          </ChatMessage>
        );
      })}
      {typingIndicator}
    </div>
  );
});
