'use client';

import { logger } from '@babylon/shared';

import { useEffect, useRef } from 'react';
import type { OutcomeNotification } from '@/components/notifications/OutcomeNotificationPopup';
import { useOutcomeNotification } from '@/components/providers/OutcomeNotificationProvider';
import { useAuth } from '@/hooks/useAuth';
import {
  isMarketResolvedData,
  type MarketResolvedData,
} from '@/types/notifications';

interface QueuedNotification {
  id: string;
  type: string;
  data?: Record<string, unknown>;
}

interface NotificationsApiResponse {
  notifications: QueuedNotification[];
}

/**
 * On mount (after authentication), fetches any undelivered `market_resolved`
 * notifications from the server and shows them via the outcome notification
 * provider. Marks them as read once delivered.
 *
 * Runs once per authenticated session — repeated mounts are no-ops via
 * `deliveredRef`. Transient failures (auth, network) reset the guard so the
 * next mount can retry. Successful delivery keeps the guard set permanently.
 */
export function useQueuedOutcomes(): void {
  const { authenticated, user } = useAuth();
  const { getAccessToken } = useAuth();
  const { showOutcome, showBatchOutcomes } = useOutcomeNotification();
  const deliveredRef = useRef(false);

  useEffect(() => {
    if (!authenticated || !user || deliveredRef.current) return;

    // Guard immediately — before any async work — to handle Strict Mode double-invoke
    deliveredRef.current = true;

    const deliver = async () => {
      let accessToken: string | null = null;
      try {
        accessToken = await getAccessToken();
      } catch {
        // Transient auth failure — reset so the next mount can retry
        deliveredRef.current = false;
        return;
      }
      if (!accessToken) {
        // Token not yet available — reset so the next mount can retry
        deliveredRef.current = false;
        return;
      }

      let body: NotificationsApiResponse;
      try {
        const res = await fetch(
          '/api/notifications?type=market_resolved&unreadOnly=true&limit=20',
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!res.ok) {
          // Server error — reset so the next mount can retry
          deliveredRef.current = false;
          return;
        }
        body = (await res.json()) as NotificationsApiResponse;
      } catch (err) {
        logger.warn(
          'Failed to fetch queued outcome notifications',
          { error: err },
          'useQueuedOutcomes'
        );
        // Network failure — reset so the next mount can retry
        deliveredRef.current = false;
        return;
      }

      const resolved = body.notifications.filter(
        (n): n is QueuedNotification & { data: MarketResolvedData } =>
          n.type === 'market_resolved' && isMarketResolvedData(n.data)
      );

      if (resolved.length === 0) return;

      const outcomes: Omit<OutcomeNotification, 'id'>[] = resolved.map((n) => ({
        marketId: n.data.marketId,
        marketName: n.data.marketName,
        outcome: n.data.outcome,
        points: n.data.points,
        agentName: n.data.agentName,
        deepLink: n.data.deepLink,
      }));

      if (outcomes.length === 1) {
        showOutcome(outcomes[0]!);
      } else {
        showBatchOutcomes(outcomes);
      }

      // Mark as read — fire-and-forget, failure is non-critical
      void fetch('/api/notifications', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          notificationIds: resolved.map((n) => n.id),
        }),
      }).catch((err) => {
        logger.warn(
          'Failed to mark outcome notifications as read',
          { error: err },
          'useQueuedOutcomes'
        );
      });
    };

    void deliver();
  }, [authenticated, user, getAccessToken, showOutcome, showBatchOutcomes]);
}
