'use client';

import { MessageCircle } from 'lucide-react';
import React from 'react';
import { Separator } from '@/components/shared/Separator';
import { ChatListSkeleton } from '@/components/shared/Skeleton';
import { ChatListItem } from './ChatListItem';
import type { Chat, ChatFilter } from './types';

interface ChatListProps {
  chats: Chat[];
  selectedChatId: string | null;
  onSelectChat: (chatId: string) => void;
  loading: boolean;
  activeFilter: ChatFilter;
  searchQuery: string;
}

export function ChatList({
  chats,
  selectedChatId,
  onSelectChat,
  loading,
  activeFilter,
  searchQuery,
}: ChatListProps) {
  if (loading) {
    return <ChatListSkeleton count={10} />;
  }

  if (chats.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-muted-foreground">
        <MessageCircle className="mx-auto mb-4 h-12 w-12 opacity-50" />
        <p className="text-sm">
          {searchQuery
            ? 'No conversations found'
            : activeFilter === 'all'
              ? 'No conversations yet'
              : activeFilter === 'dms'
                ? 'No direct messages yet'
                : 'No group chats yet'}
        </p>
        {!searchQuery && activeFilter === 'dms' && (
          <p className="mt-2 text-muted-foreground text-xs">
            Visit a user&apos;s profile to start a DM
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      {chats.map((chat, idx) => (
        <React.Fragment key={chat.id}>
          <ChatListItem
            chat={chat}
            isSelected={selectedChatId === chat.id}
            onSelect={onSelectChat}
          />
          {idx < chats.length - 1 && <Separator />}
        </React.Fragment>
      ))}
    </>
  );
}
