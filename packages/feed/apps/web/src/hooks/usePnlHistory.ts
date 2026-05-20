'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PnlHistoryScope } from '@/lib/wallet/pnl-history-types';

interface PnlPoint {
  time: number;
  value: number;
}

interface PnlHistoryState {
  points: PnlPoint[];
  loading: boolean;
  error: Error | null;
}

interface UsePnlHistoryOptions {
  entityId?: string | null;
  scope?: PnlHistoryScope;
}

export function buildPnlHistoryUrl(params: {
  entityId?: string | null;
  scope: PnlHistoryScope;
  timeframe: string;
  userId: string;
}): string {
  const searchParams = new URLSearchParams({
    range: params.timeframe,
    scope: params.scope,
  });
  if (params.entityId) {
    searchParams.set('entityId', params.entityId);
  }
  return `/api/users/${encodeURIComponent(params.userId)}/pnl-history?${searchParams.toString()}`;
}

export function usePnlHistory(
  userId: string | undefined | null,
  timeframe: string,
  options: UsePnlHistoryOptions = {}
) {
  const [state, setState] = useState<PnlHistoryState>({
    points: [],
    loading: false,
    error: null,
  });
  const controllerRef = useRef<AbortController | null>(null);
  const scope = options.scope ?? 'team';
  const entityId = options.entityId ?? null;

  const fetch_ = useCallback(async () => {
    if (!userId) {
      setState({ points: [], loading: false, error: null });
      return;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const response = await fetch(
        buildPnlHistoryUrl({
          entityId,
          scope,
          timeframe,
          userId,
        }),
        { signal: controller.signal }
      );

      if (controller.signal.aborted) return;

      if (!response.ok) {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: new Error('Failed to fetch P&L history'),
        }));
        return;
      }

      const data = await response.json();
      if (controller.signal.aborted) return;

      setState({
        points: data.data?.points ?? data.points ?? [],
        loading: false,
        error: null,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      setState((prev) => ({
        ...prev,
        loading: false,
        error:
          err instanceof Error ? err : new Error('Failed to fetch P&L history'),
      }));
    }
  }, [entityId, scope, timeframe, userId]);

  useEffect(() => {
    void fetch_();
    return () => {
      controllerRef.current?.abort();
    };
  }, [fetch_]);

  return state;
}
