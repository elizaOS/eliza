'use client';

import { cn } from '@feed/shared';

/**
 * Feed toggle component for switching between feed views.
 *
 * Tab order: For You → Stories → Latest → Following → Trades
 * Default: For You
 */
interface FeedToggleProps {
  activeTab: 'forYou' | 'stories' | 'latest' | 'following' | 'trades';
  onTabChange: (
    tab: 'forYou' | 'stories' | 'latest' | 'following' | 'trades'
  ) => void;
}

export function FeedToggle({ activeTab, onTabChange }: FeedToggleProps) {
  return (
    <div className="flex w-full items-center border-border border-b">
      <button
        type="button"
        onClick={() => onTabChange('forYou')}
        className={cn(
          'relative flex-1 py-3.5 font-semibold transition-all hover:bg-muted/20',
          activeTab === 'forYou' ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        For You
        {activeTab === 'forYou' && (
          <div className="absolute right-0 bottom-0 left-0 h-[3px] bg-primary" />
        )}
      </button>
      <button
        type="button"
        onClick={() => onTabChange('following')}
        className={cn(
          'relative flex-1 py-3.5 font-semibold transition-all hover:bg-muted/20',
          activeTab === 'following'
            ? 'text-foreground'
            : 'text-muted-foreground'
        )}
      >
        Following
        {activeTab === 'following' && (
          <div className="absolute right-0 bottom-0 left-0 h-[3px] bg-primary" />
        )}
      </button>
      <button
        type="button"
        onClick={() => onTabChange('latest')}
        className={cn(
          'relative flex-1 py-3.5 font-semibold transition-all hover:bg-muted/20',
          activeTab === 'latest' ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        Latest
        {activeTab === 'latest' && (
          <div className="absolute right-0 bottom-0 left-0 h-[3px] bg-primary" />
        )}
      </button>
      <button
        type="button"
        onClick={() => onTabChange('stories')}
        className={cn(
          'relative flex-1 py-3.5 font-semibold transition-all hover:bg-muted/20',
          activeTab === 'stories' ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        Stories
        {activeTab === 'stories' && (
          <div className="absolute right-0 bottom-0 left-0 h-[3px] bg-primary" />
        )}
      </button>
    </div>
  );
}
