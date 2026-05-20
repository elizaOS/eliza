'use client';

import { cn } from '@feed/shared';
import { Shield, Users } from 'lucide-react';
import React from 'react';
import { Avatar } from '@/components/shared/Avatar';
import type { Chat } from './types';

interface ChatListItemProps {
  chat: Chat;
  isSelected: boolean;
  onSelect: (chatId: string) => void;
}

export function ChatListItem({
  chat,
  isSelected,
  onSelect,
}: ChatListItemProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(chat.id);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(chat.id)}
      onKeyDown={handleKeyDown}
      className={cn(
        'cursor-pointer px-4 py-3 transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-inset',
        isSelected ? 'bg-sidebar-accent/50' : 'hover:bg-sidebar-accent/30'
      )}
    >
      <div className="flex items-center gap-3">
        {chat.isGroup ? (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sidebar-accent/50">
            <Users className="h-5 w-5 text-primary" />
          </div>
        ) : (
          <Avatar
            id={chat.otherUser?.id || ''}
            name={
              chat.otherUser?.displayName || chat.otherUser?.username || 'User'
            }
            type="user"
            size="md"
            imageUrl={chat.otherUser?.profileImageUrl || undefined}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate font-semibold text-foreground text-sm">
              {chat.name}
            </div>
            {chat.nftRequirement && (
              <div
                className="shrink-0"
                title={`NFT Required: ${chat.nftRequirement.tokenId !== null && chat.nftRequirement.tokenId !== undefined ? `Token #${chat.nftRequirement.tokenId}` : 'Any token'} from ${chat.nftRequirement.contractAddress.slice(0, 6)}...${chat.nftRequirement.contractAddress.slice(-4)} on ${chat.nftRequirement.chainName}`}
              >
                <Shield className="h-3.5 w-3.5 text-primary" />
              </div>
            )}
          </div>
          <div className="truncate text-muted-foreground text-xs">
            {chat.lastMessage?.content || 'No messages yet'}
          </div>
        </div>
      </div>
    </div>
  );
}
