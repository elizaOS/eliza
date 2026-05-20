"use client";

import { TeamChatView } from "@/components/chats";
import { useAuth } from "@/hooks/useAuth";
import { useTeamChat } from "@/hooks/useTeamChat";

export function TerminalAgentsChat() {
  const { authenticated, user } = useAuth();
  const {
    teamChat,
    chatDetails,
    loading,
    sending,
    error,
    sseConnected,
    isLoadingMore,
    hasMore,
    messageInput,
    handleInputChange,
    typingUsers,
    thinkingAgents,
    sendError,
    messagesEndRef,
    topSentinelRef,
    sendMessage,
    toggleReaction,
    handleScroll,
    replyToMessage,
    handleReplyToMessage,
    clearReplyToMessage,
  } = useTeamChat();

  if (!authenticated) {
    return (
      <div className="flex h-full justify-center pt-6 text-muted-foreground text-sm">
        Log in to chat with your agents.
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-muted-foreground text-sm">
        {error}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TeamChatView
        chatDetails={chatDetails}
        currentUserId={user?.id}
        authenticated={authenticated}
        sseConnected={sseConnected}
        hideHeader
        density="compact"
        loading={loading}
        isLoadingMore={isLoadingMore}
        hasMore={hasMore}
        messageInput={messageInput}
        sending={sending}
        sendError={sendError}
        topSentinelRef={topSentinelRef}
        messagesEndRef={messagesEndRef}
        onMessageChange={handleInputChange}
        onSendMessage={sendMessage}
        onToggleReaction={toggleReaction}
        agents={[
          ...(user
            ? [
                {
                  id: user.id,
                  username: user.username || null,
                  displayName: user.displayName || user.username || "You",
                  profileImageUrl: user.profileImageUrl || null,
                },
              ]
            : []),
          ...(teamChat?.agents.map((agent) => ({
            id: agent.id,
            username: agent.username,
            displayName: agent.displayName,
            profileImageUrl: agent.profileImageUrl,
          })) || []),
        ]}
        typingUsers={typingUsers}
        thinkingAgents={thinkingAgents}
        onScroll={handleScroll}
        replyToMessage={replyToMessage}
        onReply={handleReplyToMessage}
        onDismissReply={clearReplyToMessage}
      />
    </div>
  );
}
