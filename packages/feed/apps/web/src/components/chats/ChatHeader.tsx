'use client';

import { cn } from '@babylon/shared';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ChatFilter } from './types';

interface ChatHeaderProps {
  isConnected: boolean;
  activeFilter: ChatFilter;
  onFilterChange: (filter: ChatFilter) => void;
  onCreateGroup: () => void;
}

export function ChatHeader({
  isConnected,
  activeFilter,
  onFilterChange,
  onCreateGroup,
}: ChatHeaderProps) {
  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="font-bold text-foreground text-xl">Messages</h2>
          {isConnected ? (
            <span
              className="flex items-center gap-1 font-medium text-green-500 text-xs"
              data-testid="sse-status"
            >
              <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
              Live
            </span>
          ) : (
            <span
              className="flex items-center gap-1 font-medium text-xs text-yellow-500"
              data-testid="sse-status"
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              Connecting
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onCreateGroup}
          title="Create Group"
        >
          <Plus className="h-5 w-5" />
        </Button>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center border-border border-b">
        <button
          onClick={() => onFilterChange('all')}
          aria-label="Show all conversations"
          className={cn(
            'relative min-h-[44px] flex-1 font-semibold transition-all hover:bg-muted/20',
            activeFilter === 'all' ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          All
          {activeFilter === 'all' && (
            <span className="absolute right-0 bottom-0 left-0 h-0.5 bg-primary" />
          )}
        </button>
        <button
          onClick={() => onFilterChange('dms')}
          aria-label="Show direct messages"
          className={cn(
            'relative min-h-[44px] flex-1 font-semibold transition-all hover:bg-muted/20',
            activeFilter === 'dms' ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          DMs
          {activeFilter === 'dms' && (
            <span className="absolute right-0 bottom-0 left-0 h-0.5 bg-primary" />
          )}
        </button>
        <button
          onClick={() => onFilterChange('groups')}
          aria-label="Show group chats"
          className={cn(
            'relative min-h-[44px] flex-1 font-semibold transition-all hover:bg-muted/20',
            activeFilter === 'groups'
              ? 'text-foreground'
              : 'text-muted-foreground'
          )}
        >
          Groups
          {activeFilter === 'groups' && (
            <span className="absolute right-0 bottom-0 left-0 h-0.5 bg-primary" />
          )}
        </button>
      </div>
    </div>
  );
}
