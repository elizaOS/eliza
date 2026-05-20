/**
 * Auto Daily Reward Hook
 *
 * Silently claims the daily login reward when an authenticated user
 * loads the app. Fires once per session — idempotent on the server side.
 */

import { logger } from '@babylon/shared';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';

export function useAutoDailyReward(): void {
  const { authenticated, ready, user, getAccessToken, refresh } = useAuth();
  const claimedRef = useRef(false);

  useEffect(() => {
    if (!ready || !authenticated || !user?.id || claimedRef.current) return;
    claimedRef.current = true;

    const claim = async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;

        const res = await fetch('/api/users/daily-login', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });

        if (res.ok) {
          const result = await res.json();
          if (!result.success) return; // already claimed today or error
          toast.success(
            `+${result.totalAwarded} reputation! Streak: ${result.streak} days`
          );
          window.dispatchEvent(new CustomEvent('rewards-updated'));
          refresh();
        }
      } catch (err) {
        logger.debug(
          'Auto daily reward claim failed',
          { error: err instanceof Error ? err.message : String(err) },
          'useAutoDailyReward'
        );
      }
    };

    void claim();
  }, [ready, authenticated, user?.id, getAccessToken, refresh]);
}

/** Provider that enables auto daily reward for its subtree */
export function AutoDailyRewardProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactNode {
  useAutoDailyReward();
  return children;
}
