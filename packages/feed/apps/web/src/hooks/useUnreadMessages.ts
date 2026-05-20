import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { apiUrl } from '@/utils/api-url';

/**
 * Represents unread message counts.
 */
interface UnreadCounts {
  /** Number of pending DM requests from anonymous users */
  pendingDMs: number;
  /** Number of unread chat message notifications */
  unreadMessages: number;
  /** Whether there are new messages in existing chats */
  hasNewMessages: boolean;
}

/**
 * Hook for efficiently polling unread and pending message counts.
 *
 * Polls the API every 30 seconds to check for:
 * - Pending DM requests from anonymous users
 * - New messages in existing chats
 *
 * Returns counts suitable for displaying notification badges. Only polls
 * when the user is authenticated. Automatically stops polling on unmount
 * or when user logs out.
 *
 * @returns An object containing:
 * - `pendingDMs`: Number of pending DM requests
 * - `unreadMessages`: Number of unread chat notifications
 * - `hasNewMessages`: Whether there are new messages in existing chats
 * - `totalUnread`: Combined unread count (pending DM requests + unread chat notifications)
 * - `isLoading`: Whether counts are currently being fetched
 *
 * @example
 * ```tsx
 * const { pendingDMs, hasNewMessages, totalUnread } = useUnreadMessages();
 *
 * return (
 *   <Badge>
 *     {totalUnread > 0 && totalUnread}
 *   </Badge>
 * );
 * ```
 */
export function useUnreadMessages() {
  const { authenticated, getAccessToken } = useAuth();
  const [counts, setCounts] = useState<UnreadCounts>({
    pendingDMs: 0,
    unreadMessages: 0,
    hasNewMessages: false,
  });
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // Only poll if user is authenticated
    if (!authenticated) {
      setCounts({ pendingDMs: 0, unreadMessages: 0, hasNewMessages: false });
      return;
    }

    // Fetch unread counts
    const fetchCounts = async () => {
      const token = await getAccessToken();
      if (!token) return;

      const response = await fetch(apiUrl('/api/chats/unread-count'), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        setIsLoading(false);
        return;
      }

      const data = await response.json();
      const pendingDMRequests =
        typeof data.pendingDMRequests === 'number'
          ? data.pendingDMRequests
          : typeof data.pendingDMs === 'number'
            ? data.pendingDMs
            : 0;
      const unreadMessages =
        typeof data.unreadMessages === 'number'
          ? data.unreadMessages
          : data.hasNewMessages
            ? 1
            : 0;
      setCounts({
        pendingDMs: pendingDMRequests,
        unreadMessages,
        hasNewMessages: data.hasNewMessages || false,
      });
      setIsLoading(false);
    };

    // Initial fetch
    setIsLoading(true);
    fetchCounts();

    // Poll every 30 seconds
    const interval = setInterval(fetchCounts, 30000);

    return () => clearInterval(interval);
  }, [authenticated, getAccessToken]);

  return {
    ...counts,
    totalUnread: counts.pendingDMs + counts.unreadMessages,
    isLoading,
  };
}
