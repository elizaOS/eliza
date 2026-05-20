'use client';

import { cn } from '@babylon/shared';
import { Bot } from 'lucide-react';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Avatar } from '@/components/shared/Avatar';

/** Agent that can be mentioned */
export interface MentionableAgent {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
}

interface MentionAutocompleteProps {
  /** List of agents that can be mentioned (already filtered by useMentionAutocomplete hook) */
  agents: MentionableAgent[];
  /** Whether the dropdown is visible */
  isOpen: boolean;
  /** Currently selected index */
  selectedIndex: number;
  /** Callback when an agent is selected */
  onSelect: (agent: MentionableAgent) => void;
  /** Callback when selection index changes */
  onIndexChange: (index: number) => void;
  /** Callback when dropdown should close */
  onClose: () => void;
}

/**
 * Autocomplete dropdown for @mentions in chat
 *
 * Note: `agents` prop should already be filtered by the parent (via useMentionAutocomplete hook).
 * This avoids duplicate filtering logic.
 */
export function MentionAutocomplete({
  agents,
  isOpen,
  selectedIndex,
  onSelect,
  onIndexChange,
  onClose,
}: MentionAutocompleteProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Agents are already filtered by useMentionAutocomplete hook
  const filteredAgents = agents;

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () =>
        document.removeEventListener('mousedown', handleClickOutside);
    }
    return undefined;
  }, [isOpen, onClose]);

  // Keep selected index in bounds
  useEffect(() => {
    if (selectedIndex >= filteredAgents.length) {
      onIndexChange(Math.max(0, filteredAgents.length - 1));
    }
  }, [filteredAgents.length, selectedIndex, onIndexChange]);

  if (!isOpen || filteredAgents.length === 0) {
    return null;
  }

  // Generate stable ID for the currently selected option
  const activeDescendantId = filteredAgents[selectedIndex]
    ? `mention-option-${filteredAgents[selectedIndex].id}`
    : undefined;

  return (
    <div
      ref={containerRef}
      role="listbox"
      aria-label="Mention suggestions"
      aria-activedescendant={activeDescendantId}
      className="absolute right-0 bottom-full left-0 z-50 mb-2 overflow-hidden rounded-lg border border-border bg-popover shadow-lg sm:right-auto sm:w-80"
    >
      <div className="max-h-48 overflow-y-auto">
        {filteredAgents.map((agent, index) => (
          <button
            key={agent.id}
            id={`mention-option-${agent.id}`}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            onClick={() => onSelect(agent)}
            onMouseEnter={() => onIndexChange(index)}
            className={cn(
              'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors',
              index === selectedIndex
                ? 'bg-accent text-accent-foreground'
                : 'hover:bg-muted'
            )}
          >
            <Avatar
              src={agent.profileImageUrl ?? undefined}
              name={agent.displayName || agent.username || 'Agent'}
              size="sm"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-foreground text-sm">
                {agent.displayName || agent.username || 'Agent'}
              </p>
              {agent.username && (
                <p className="truncate text-muted-foreground text-xs">
                  @{agent.username}
                </p>
              )}
            </div>
            <Bot className="h-4 w-4 flex-shrink-0 text-blue-500" />
          </button>
        ))}
      </div>
      <div className="border-border border-t bg-muted/50 px-3 py-1.5">
        <p className="text-muted-foreground text-xs">
          <kbd className="rounded bg-muted px-1 font-mono">↑↓</kbd> to navigate,{' '}
          <kbd className="rounded bg-muted px-1 font-mono">Enter</kbd> to
          select, <kbd className="rounded bg-muted px-1 font-mono">Esc</kbd> to
          close
        </p>
      </div>
    </div>
  );
}

/**
 * Hook to manage @mention autocomplete state
 */
export function useMentionAutocomplete(agents: MentionableAgent[]) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mentionStartIndex, setMentionStartIndex] = useState(-1);

  // Filter agents for current query (memoized to avoid unnecessary recalculation)
  const filteredAgents = useMemo(() => {
    return agents.filter((agent) => {
      if (!query) return true;
      const searchLower = query.toLowerCase();
      const displayNameMatch = agent.displayName
        ?.toLowerCase()
        .includes(searchLower);
      const usernameMatch = agent.username?.toLowerCase().includes(searchLower);
      return displayNameMatch || usernameMatch;
    });
  }, [agents, query]);

  const openAutocomplete = useCallback((startIndex: number) => {
    setIsOpen(true);
    setMentionStartIndex(startIndex);
    setQuery('');
    setSelectedIndex(0);
  }, []);

  const closeAutocomplete = useCallback(() => {
    setIsOpen(false);
    setQuery('');
    setMentionStartIndex(-1);
    setSelectedIndex(0);
  }, []);

  const updateQuery = useCallback((newQuery: string) => {
    setQuery(newQuery);
    setSelectedIndex(0);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!isOpen) return false;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < filteredAgents.length - 1 ? prev + 1 : 0
          );
          return true;

        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev > 0 ? prev - 1 : filteredAgents.length - 1
          );
          return true;

        case 'Enter':
        case 'Tab':
          if (filteredAgents.length > 0) {
            e.preventDefault();
            return true; // Signal that we should select
          }
          return false;

        case 'Escape':
          e.preventDefault();
          closeAutocomplete();
          return true;

        default:
          return false;
      }
    },
    [isOpen, filteredAgents.length, closeAutocomplete]
  );

  const getSelectedAgent = useCallback((): MentionableAgent | null => {
    if (!isOpen || filteredAgents.length === 0) return null;
    return filteredAgents[selectedIndex] || null;
  }, [isOpen, filteredAgents, selectedIndex]);

  return {
    isOpen,
    query,
    selectedIndex,
    mentionStartIndex,
    filteredAgents,
    openAutocomplete,
    closeAutocomplete,
    updateQuery,
    handleKeyDown,
    getSelectedAgent,
    setSelectedIndex,
  };
}
