'use client';

import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { TradeSide } from '@/types/markets';
import { type OpenPerpPreviewResponse, usePerpTrade } from './usePerpTrade';

interface UsePerpOpenPreviewParams {
  ticker: string | null;
  side: TradeSide;
  size: number;
  leverage: number;
  enabled?: boolean;
  getAccessToken?: () => Promise<string | null> | string | null;
}

interface PreviewState {
  preview: OpenPerpPreviewResponse['preview'] | null;
  loading: boolean;
  error: string | null;
}

export function usePerpOpenPreview({
  ticker,
  side,
  size,
  leverage,
  enabled = true,
  getAccessToken,
}: UsePerpOpenPreviewParams): PreviewState {
  const { previewOpenPosition } = usePerpTrade({ getAccessToken });
  const deferredSize = useDeferredValue(size);
  const deferredLeverage = useDeferredValue(leverage);
  const normalizedTicker = useMemo(
    () => ticker?.trim().toUpperCase() ?? null,
    [ticker]
  );
  const [state, setState] = useState<PreviewState>({
    preview: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (
      !enabled ||
      !normalizedTicker ||
      !Number.isFinite(deferredSize) ||
      deferredSize <= 0 ||
      !Number.isFinite(deferredLeverage) ||
      deferredLeverage < 1
    ) {
      setState((current) =>
        current.preview === null &&
        current.loading === false &&
        current.error === null
          ? current
          : {
              preview: null,
              loading: false,
              error: null,
            }
      );
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      setState((current) => ({
        preview: current.preview,
        loading: true,
        error: null,
      }));

      void previewOpenPosition(
        {
          ticker: normalizedTicker,
          side,
          size: deferredSize,
          leverage: deferredLeverage,
        },
        controller.signal
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          setState({
            preview: result.preview,
            loading: false,
            error: null,
          });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const message =
            error instanceof Error
              ? error.message
              : 'Failed to fetch perp preview';
          setState((current) => ({
            preview: current.preview,
            loading: false,
            error: message,
          }));
        });
    }, 120);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [
    deferredLeverage,
    deferredSize,
    enabled,
    normalizedTicker,
    previewOpenPosition,
    side,
  ]);

  return state;
}
