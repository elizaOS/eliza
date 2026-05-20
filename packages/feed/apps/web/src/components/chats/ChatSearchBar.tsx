'use client';

import { cn } from '@babylon/shared';
import { Search, X } from 'lucide-react';

interface ChatSearchBarProps {
  value: string;
  onChange: (value: string) => void;
}

export function ChatSearchBar({ value, onChange }: ChatSearchBarProps) {
  return (
    <div className="relative mb-2 px-4">
      <Search className="absolute top-1/2 left-7 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <input
        type="text"
        placeholder="Search conversations..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'w-full rounded-lg py-2 pr-9 pl-9 text-sm',
          'message-input bg-sidebar-accent/50',
          'text-foreground placeholder:text-muted-foreground',
          'outline-none'
        )}
      />
      {value && (
        <button
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute top-1/2 right-4 flex min-h-[44px] min-w-[44px] -translate-y-1/2 items-center justify-center rounded-md transition-colors hover:bg-muted-foreground/20"
        >
          <X className="h-4 w-4 text-foreground" />
        </button>
      )}
    </div>
  );
}
