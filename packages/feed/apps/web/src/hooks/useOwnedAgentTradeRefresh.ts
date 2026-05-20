'use client';

import { logger } from '@feed/shared';
import { useCallback, useEffect, useMemo } from 'react';
import { refreshOwnedPortfolioState } from '@/stores/portfolioRefresh';
import { isAgentTradeActivityMessage } from './ownedAgentTradeRefresh.shared';
import { useSSE } from './useSSE';

interface UseOwnedAgentTradeRefreshOptions {
  userId?: string | null;
  agentIds: string[];
  onTrade?: () => void;
}

export function useOwnedAgentTradeRefresh({
  userId,
  agentIds,
  onTrade,
}: UseOwnedAgentTradeRefreshOptions) {
  const { subscribe } = useSSE();

  const agentIdsKey = useMemo(
    () =>
      Array.from(new Set(agentIds.filter(Boolean)))
        .sort()
        .join(','),
    [agentIds]
  );
  const stableAgentIds = useMemo(
    () => (agentIdsKey ? agentIdsKey.split(',') : []),
    [agentIdsKey]
  );

  const handleAgentActivity = useCallback(
    (data: Record<string, unknown>) => {
      if (!userId || !isAgentTradeActivityMessage(data)) {
        return;
      }

      onTrade?.();

      refreshOwnedPortfolioState(userId).catch((error) => {
        logger.warn(
          'Failed to refresh owned portfolio after agent trade',
          {
            userId,
            error: error instanceof Error ? error.message : String(error),
          },
          'useOwnedAgentTradeRefresh'
        );
      });
    },
    [onTrade, userId]
  );

  useEffect(() => {
    if (!userId || stableAgentIds.length === 0) {
      return;
    }

    const unsubscribes = stableAgentIds.map((agentId) => {
      const channel = `agent:${agentId}` as const;
      return subscribe(channel, (message) => {
        if (message.channel !== channel) {
          return;
        }

        handleAgentActivity(message.data);
      });
    });

    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [handleAgentActivity, stableAgentIds, subscribe, userId]);
}
