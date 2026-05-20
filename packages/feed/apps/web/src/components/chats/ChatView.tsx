"use client";

import { MessageCircle } from "lucide-react";
import type React from "react";
import { useMemo } from "react";
import { Separator } from "@/components/shared/Separator";
import { ChatViewHeader } from "./ChatViewHeader";
import { FeedbackMessages } from "./FeedbackMessages";
import type { MentionableAgent } from "./MentionAutocomplete";
import { MessageInput } from "./MessageInput";
import { MessageList } from "./MessageList";
import { NftVerificationBanner } from "./NftVerificationBanner";
import type { ChatDetails, Message, ReplyToMessage } from "./types";

interface ChatViewProps {
  chatDetails: ChatDetails | null;
  currentUserId: string | undefined;
  authenticated: boolean;
  sseConnected: boolean;
  loading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  messageInput: string;
  sending: boolean;
  sendError: string | null;
  sendWarning: string | null;
  sendSuccess: boolean;
  showBackButton?: boolean;
  containerRef: (node: HTMLDivElement | null) => void;
  topSentinelRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  onBack?: () => void;
  onManageGroup: () => void;
  onMessageChange: (value: string) => void;
  onSendMessage: () => void;
  onToggleReaction?: (
    messageId: string,
    emoji: string,
    currentlyReactedByMe: boolean,
  ) => void;
  /** Message being replied to */
  replyToMessage?: ReplyToMessage | null;
  /** Called when user initiates reply to a message */
  onReply?: (message: Message) => void;
  /** Called when user dismisses the reply */
  onDismissReply?: () => void;
}

export function ChatView({
  chatDetails,
  currentUserId,
  authenticated,
  sseConnected,
  loading,
  isLoadingMore,
  hasMore,
  messageInput,
  sending,
  sendError,
  sendWarning,
  sendSuccess,
  showBackButton = false,
  containerRef,
  topSentinelRef,
  messagesEndRef,
  onBack,
  onManageGroup,
  onMessageChange,
  onSendMessage,
  onToggleReaction,
  replyToMessage,
  onReply,
  onDismissReply,
}: ChatViewProps) {
  // Convert chat participants to mentionable members format
  const mentionableMembers: MentionableAgent[] = useMemo(() => {
    if (!chatDetails?.participants) return [];
    return chatDetails.participants.map((p) => ({
      id: p.id,
      username: p.username || null,
      displayName: p.displayName || null,
      profileImageUrl: p.profileImageUrl || null,
    }));
  }, [chatDetails?.participants]);

  // Empty state when no chat selected
  if (!chatDetails) {
    return (
      <div className="flex h-full flex-1 items-center justify-center">
        <div className="max-w-md p-8 text-center text-muted-foreground">
          <MessageCircle className="mx-auto mb-4 h-16 w-16 opacity-50" />
          <h3 className="mb-2 font-bold text-foreground text-xl">
            Select a chat
          </h3>
          <p className="text-sm">
            Choose a conversation from the list to view messages
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Chat Header - Fixed */}
      <div className="shrink-0">
        <ChatViewHeader
          chatDetails={chatDetails}
          sseConnected={sseConnected}
          showBackButton={showBackButton}
          onBack={onBack}
          onManageGroup={onManageGroup}
        />

        {/* Header Separator */}
        <div className="px-4">
          <Separator />
        </div>

        {/* NFT Verification Banner */}
        {chatDetails.chat.nftRequirement && (
          <NftVerificationBanner
            chatDetails={chatDetails}
            currentUserId={currentUserId}
          />
        )}
      </div>

      {/* Messages - Scrollable */}
      <div
        ref={containerRef}
        className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3"
      >
        <div className="flex flex-col space-y-4">
          <MessageList
            messages={chatDetails.messages || []}
            participants={chatDetails.participants || []}
            currentUserId={currentUserId}
            loading={loading}
            isLoadingMore={isLoadingMore}
            hasMore={hasMore}
            authenticated={authenticated}
            topSentinelRef={topSentinelRef}
            messagesEndRef={messagesEndRef}
            onToggleReaction={onToggleReaction}
            onReply={onReply}
          />
        </div>
      </div>

      {/* Footer - Fixed */}
      <div className="shrink-0 pb-safe md:pb-0">
        {/* Feedback Messages */}
        {authenticated && (
          <FeedbackMessages
            error={sendError}
            warning={sendWarning}
            success={sendSuccess}
          />
        )}

        {/* Message Input with mention support */}
        <MessageInput
          value={messageInput}
          onChange={onMessageChange}
          onSend={onSendMessage}
          sending={sending}
          authenticated={authenticated}
          mentionableMembers={mentionableMembers}
          replyToMessage={replyToMessage}
          onDismissReply={onDismissReply}
        />
      </div>
    </div>
  );
}
