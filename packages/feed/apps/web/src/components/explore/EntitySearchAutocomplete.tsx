'use client';

import { cn } from '@feed/shared';
import { ArrowRight, Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar } from '@/components/shared/Avatar';
import { apiUrl } from '@/utils/api-url';

/**
 * API user structure from registry API.
 */
interface ApiUser {
  id: string;
  name: string;
  username?: string;
  bio?: string;
  imageUrl?: string;
  isActor?: boolean;
}

/**
 * API actor structure from registry API.
 */
interface ApiActor {
  id: string;
  name: string;
  description?: string;
  imageUrl?: string;
  role?: string;
}

/**
 * Registry entity structure for search results.
 */
interface RegistryEntity {
  id: string;
  name: string;
  username?: string;
  bio?: string;
  imageUrl?: string;
  type: 'user' | 'actor';
}

/**
 * Entity search autocomplete component for searching users and actors.
 *
 * Provides an autocomplete search input for finding users and actors from
 * the registry. Displays search suggestions with avatars and navigation.
 * Supports keyboard navigation and click selection.
 *
 * Features:
 * - Autocomplete search
 * - User and actor results
 * - Avatar display
 * - Keyboard navigation
 * - Click selection
 * - Navigation to profiles
 * - Debounced search
 * - Loading states
 *
 * @param props - EntitySearchAutocomplete component props
 * @returns Entity search autocomplete element
 *
 * @example
 * ```tsx
 * <EntitySearchAutocomplete
 *   value={searchQuery}
 *   onChange={setSearchQuery}
 *   placeholder="Search users..."
 * />
 * ```
 */
interface EntitySearchAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  compact?: boolean;
  onNavigate?: () => void;
  searchType?: 'all' | 'users' | 'actors' | 'agents' | 'apps';
}

export function EntitySearchAutocomplete({
  value,
  onChange,
  placeholder = 'Search...',
  className,
  compact = false,
  onNavigate,
  searchType = 'all',
}: EntitySearchAutocompleteProps) {
  const router = useRouter();
  const [suggestions, setSuggestions] = useState<RegistryEntity[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const fetchSuggestions = async () => {
      if (!value.trim()) {
        setSuggestions([]);
        setIsOpen(false);
        setSelectedIndex(-1);
        return;
      }

      setLoading(true);
      const params = new URLSearchParams({
        search: value,
        type: searchType,
      });
      const response = await fetch(
        apiUrl(`/api/registry/all?${params.toString()}`)
      );
      if (response.ok) {
        const data = await response.json();
        // Filter out NPC users (isActor: true) - they appear in the actors array
        const users: RegistryEntity[] = (data.users || [])
          .filter((u: ApiUser) => !u.isActor)
          .map((u: ApiUser) => ({
            id: u.id,
            name: u.name,
            username: u.username,
            bio: u.bio,
            imageUrl: u.imageUrl,
            type: 'user' as const,
          }));
        const actors: RegistryEntity[] = (data.actors || []).map(
          (a: ApiActor) => ({
            id: a.id,
            name: a.name,
            username: undefined,
            bio: a.description || a.role,
            imageUrl: a.imageUrl,
            type: 'actor' as const,
          })
        );
        const allEntities = [...users, ...actors];
        setSuggestions(allEntities.slice(0, 10));
        setIsOpen(true);
        setSelectedIndex(allEntities.length ? 0 : -1);
      } else {
        setSuggestions([]);
        setIsOpen(false);
        setSelectedIndex(-1);
      }
      setLoading(false);
    };

    const timer = setTimeout(fetchSuggestions, 250);
    return () => clearTimeout(timer);
  }, [value, searchType]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setSelectedIndex(-1);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const navigateToEntity = useCallback(
    (entity: RegistryEntity) => {
      // For users, use username if available, otherwise use ID
      // For actors, always use ID
      const identifier = entity.username || entity.id;
      router.push(`/profile/${identifier}`);
      onNavigate?.();
      setIsOpen(false);
      setSelectedIndex(-1);
      onChange('');
    },
    [router, onNavigate, onChange]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (!isOpen) {
        if (event.key === 'Enter' && suggestions.length > 0 && suggestions[0]) {
          event.preventDefault();
          navigateToEntity(suggestions[0]);
        }
        return;
      }

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setSelectedIndex((prev) =>
            prev < suggestions.length - 1 ? prev + 1 : suggestions.length - 1
          );
          break;
        case 'ArrowUp':
          event.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : 0));
          break;
        case 'Enter':
          event.preventDefault();
          if (selectedIndex >= 0 && selectedIndex < suggestions.length) {
            const entity = suggestions[selectedIndex];
            if (entity) {
              navigateToEntity(entity);
            }
          } else if (suggestions.length > 0) {
            const entity = suggestions[0];
            if (entity) {
              navigateToEntity(entity);
            }
          }
          break;
        case 'Escape':
          setIsOpen(false);
          setSelectedIndex(-1);
          break;
      }
    },
    [isOpen, suggestions, selectedIndex, navigateToEntity]
  );

  return (
    <div ref={wrapperRef} className={cn('relative', className)}>
      <div
        className={cn(
          'pointer-events-none absolute top-1/2 z-10 -translate-y-1/2',
          compact ? 'left-3' : 'left-4'
        )}
      >
        <Search
          className={cn(compact ? 'h-3.5 w-3.5' : 'h-4 w-4', 'text-primary')}
        />
      </div>
      <input
        ref={inputRef}
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => {
          if (value.trim() && suggestions.length > 0) {
            setIsOpen(true);
          }
        }}
        onKeyDown={handleKeyDown}
        className={cn(
          'w-full',
          'border border-border bg-transparent',
          'focus:border-border focus:outline-none',
          'transition-all duration-200',
          'text-foreground',
          compact ? 'py-1.5 pr-9 pl-9 text-sm' : 'py-2.5 pr-10 pl-11',
          'rounded-full'
        )}
      />
      {value && (
        <button
          onClick={() => {
            onChange('');
            setSuggestions([]);
            setIsOpen(false);
            setSelectedIndex(-1);
          }}
          className={cn(
            'absolute top-1/2 z-10 -translate-y-1/2 p-1 transition-colors hover:bg-muted/50',
            compact ? 'right-2' : 'right-3'
          )}
        >
          <X
            className={cn(
              compact ? 'h-3.5 w-3.5' : 'h-4 w-4',
              'text-muted-foreground'
            )}
          />
        </button>
      )}

      {isOpen && (
        <div className="absolute top-full right-0 left-0 z-50 mt-2 max-h-[400px] overflow-hidden overflow-y-auto rounded-2xl border border-border bg-card shadow-xl">
          {loading && (
            <div className="px-4 py-6 text-center text-muted-foreground text-sm">
              Searching…
            </div>
          )}

          {!loading && suggestions.length === 0 && (
            <div className="px-4 py-6 text-center text-muted-foreground text-sm">
              No matching users found
            </div>
          )}

          {!loading && suggestions.length > 0 && (
            <div className="py-2">
              <div className="px-4 py-2 font-semibold text-muted-foreground text-xs uppercase">
                Results
              </div>
              {suggestions.map((entity, index) => (
                <button
                  key={entity.id}
                  onClick={() => navigateToEntity(entity)}
                  className={cn(
                    'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50',
                    selectedIndex === index && 'bg-muted/50'
                  )}
                >
                  <Avatar
                    id={entity.id}
                    src={entity.imageUrl || undefined}
                    name={entity.name}
                    type={entity.type === 'actor' ? 'actor' : 'user'}
                    size="sm"
                    className="shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <p className="truncate font-semibold text-foreground text-sm">
                        {entity.name}
                      </p>
                    </div>
                    {entity.username && (
                      <p className="truncate text-muted-foreground text-xs">
                        @{entity.username}
                      </p>
                    )}
                    {!entity.username && entity.bio && (
                      <p className="truncate text-muted-foreground text-xs">
                        {entity.bio}
                      </p>
                    )}
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <style>{`
        input::placeholder {
          color: hsl(var(--muted-foreground));
          opacity: 0.6;
        }
      `}</style>
    </div>
  );
}
