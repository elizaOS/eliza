'use client';

import { ArrowLeft, Loader2, Settings } from 'lucide-react';
import Link from 'next/link';
import { Avatar } from '@/components/shared/Avatar';
import { Button } from '@/components/ui/button';
import type { ChatDetails } from './types';
import { getProfilePath } from './types';

interface ChatViewHeaderProps {
  chatDetails: ChatDetails;
  sseConnected: boolean;
  showBackButton?: boolean;
  onBack?: () => void;
  onManageGroup: () => void;
}

export function ChatViewHeader({
  chatDetails,
  sseConnected,
  showBackButton = false,
  onBack,
  onManageGroup,
}: ChatViewHeaderProps) {
  return (
    <div className="overflow-hidden bg-background px-4 py-2 md:py-4">
      <div className="flex min-w-0 items-center gap-3">
        {showBackButton && (
          <button
            onClick={onBack}
            className="rounded-md p-1.5 text-foreground transition-colors hover:bg-sidebar-accent/50 lg:hidden"
            aria-label="Back"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}

        {/* Avatar (DM only) */}
        {chatDetails.chat.isGroup ? null : chatDetails.chat.otherUser ? (
          <Link
            href={getProfilePath(chatDetails.chat.otherUser)}
            className="transition-opacity hover:opacity-80"
          >
            <Avatar
              id={chatDetails.chat.otherUser.id}
              name={chatDetails.chat.otherUser.displayName || 'User'}
              type="user"
              size="md"
              imageUrl={chatDetails.chat.otherUser.profileImageUrl || undefined}
            />
          </Link>
        ) : (
          <Avatar id="" name="User" type="user" size="md" />
        )}

        {/* Chat name and status */}
        <div className="min-w-0 flex-1">
          {chatDetails.chat.isGroup ? (
            <h3 className="truncate font-bold text-foreground text-lg">
              {chatDetails.chat.name || 'Chat'}
            </h3>
          ) : chatDetails.chat.otherUser ? (
            <Link
              href={getProfilePath(chatDetails.chat.otherUser)}
              className="truncate font-bold text-foreground text-lg transition-colors hover:text-primary"
            >
              {chatDetails.chat.otherUser.displayName || 'Chat'}
            </Link>
          ) : (
            <h3 className="truncate font-bold text-foreground text-lg">Chat</h3>
          )}

          <div className="-mt-0.5 flex items-center gap-2 md:mt-0">
            {chatDetails.chat.isGroup && (
              <span className="text-muted-foreground text-xs">
                {chatDetails.participants.length} participants
              </span>
            )}
            {/* SSE status */}
            {sseConnected ? (
              <span
                className="flex items-center gap-1 font-medium text-green-500 text-xs"
                data-testid="chat-sse-status"
              >
                <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
                Live
              </span>
            ) : (
              <span
                className="flex items-center gap-1 font-medium text-xs text-yellow-500"
                data-testid="chat-sse-status"
              >
                <Loader2 className="h-3 w-3 animate-spin" />
                Connecting
              </span>
            )}
          </div>
        </div>

        {/* Group actions */}
        {chatDetails.chat.isGroup && (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={onManageGroup}
            title="Manage Group"
          >
            <Settings className="h-5 w-5" />
          </Button>
        )}
      </div>
    </div>
  );
}
