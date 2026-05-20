import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { getAuthToken } from "@/lib/auth";

/**
 * Hook for polling unread notification count.
 *
 * Polls `/api/notifications?unreadOnly=true&limit=1` every 60 seconds
 * to check for unread notifications. Only polls when the user is
 * authenticated. Automatically stops polling on unmount or logout.
 *
 * @returns An object containing:
 * - `unreadCount`: Number of unread notifications
 *
 * @example
 * ```tsx
 * const { unreadCount } = useUnreadNotifications();
 *
 * return unreadCount > 0 && <Badge />;
 * ```
 */
export function useUnreadNotifications() {
  const { authenticated, user } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (!authenticated || !user) {
      setUnreadCount(0);
      return;
    }

    const fetchUnreadCount = async () => {
      const token = getAuthToken();
      if (!token) return;

      try {
        const response = await fetch(
          "/api/notifications?unreadOnly=true&limit=1",
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );

        if (response.ok) {
          const data = await response.json();
          setUnreadCount(data.unreadCount || 0);
        }
      } catch {
        // Silently fail — badge will just not update on network errors
      }
    };

    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 60000);
    return () => clearInterval(interval);
  }, [authenticated, user]);

  return { unreadCount };
}
