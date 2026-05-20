'use client';

import { useCallback } from 'react';
import { getAuthToken } from '@/lib/auth';
import type { TradeSide } from '@/types/markets';
import { apiUrl } from '@/utils/api-url';

// Re-export for backwards compatibility
export type { TradeSide } from '@/types/markets';

/**
 * Options for configuring the usePerpTrade hook.
 */
interface UsePerpTradeOptions {
  /** Optional function to get the access token. Falls back to getAuthToken() */
  getAccessToken?: () => Promise<string | null> | string | null;
}

/**
 * Payload for opening a perpetual position.
 */
interface OpenPerpPayload {
  /** Ticker symbol (e.g., 'AAPL', 'TSLA') */
  ticker: string;
  /** Trade side: 'long' or 'short' */
  side: TradeSide;
  /** Position size */
  size: number;
  /** Leverage multiplier */
  leverage: number;
}

export interface OpenPerpPreviewPayload extends OpenPerpPayload {}

export interface OpenPerpPreviewResponse {
  preview: {
    settlementMode: 'offchain' | 'onchain';
    previewType?: 'open' | 'add' | 'reduce' | 'close' | 'flip';
    isRebalance?: boolean;
    rebalanceType?: 'add' | 'reduce' | 'close' | 'flip';
    ticker: string;
    side: TradeSide;
    size: number;
    leverage: number;
    currentPrice: number;
    markPrice?: number;
    indexPrice?: number;
    quotedPrice: number;
    executionPrice: number;
    quoteImpactPrice: number;
    quoteImpactBps: number;
    totalSlippageBps: number;
    bidPrice?: number;
    askPrice?: number;
    spreadBps?: number;
    bidDepth?: number;
    askDepth?: number;
    liquidityRegime?: 'thin' | 'balanced' | 'deep';
    marginRequired: number;
    estimatedFee: number;
    totalRequired: number;
    resultingSize?: number;
    resultingSide?: TradeSide | null;
    estimatedClosePrice?: number;
    estimatedCloseSettlement?: number;
    liquidationPrice?: number;
    liquidationDistancePercent?: number;
  };
}

interface ApiPerpPosition {
  id: string;
  ticker: string;
  side: TradeSide;
  entryPrice: number;
  currentPrice: number;
  size: number;
  leverage: number;
  liquidationPrice?: number;
  realizedPnL?: number;
  fundingPaid: number;
  openedAt?: string;
  exitPrice?: number;
}

interface OpenPerpResponse {
  position: ApiPerpPosition;
  marginPaid: number;
  fee: {
    amount: number;
    referrerPaid: number;
  };
  newBalance: number;
}

interface ClosePerpResponse {
  position: ApiPerpPosition;
  grossSettlement: number;
  netSettlement: number;
  marginReturned: number;
  pnl: number;
  realizedPnL?: number;
  fee: {
    amount: number;
    referrerPaid: number;
  };
  wasLiquidated: boolean;
  newBalance: number;
}

async function resolveToken(
  resolver?: () => Promise<string | null> | string | null
): Promise<string | null> {
  if (!resolver) {
    return getAuthToken();
  }

  const value = typeof resolver === 'function' ? resolver() : resolver;
  const token = await Promise.resolve(value);
  if (token) return token;
  return getAuthToken();
}

function extractErrorMessage(
  payload: Record<string, unknown> | null,
  status: number
): string {
  if (
    payload &&
    typeof payload === 'object' &&
    'error' in payload &&
    payload.error !== undefined
  ) {
    const errorPayload = payload.error;

    if (typeof errorPayload === 'string') {
      return errorPayload;
    }

    if (
      errorPayload &&
      typeof errorPayload === 'object' &&
      'message' in errorPayload &&
      typeof (errorPayload as { message?: string }).message === 'string'
    ) {
      return (errorPayload as { message: string }).message;
    }

    return JSON.stringify(errorPayload);
  }

  return `Request failed with status ${status}`;
}

/**
 * Hook for executing perpetual market trades.
 *
 * Provides functions to open and close perpetual positions. Handles authentication
 * automatically using the access token. All API calls include proper error handling
 * and type-safe responses.
 *
 * @param options - Optional configuration including custom access token resolver
 *
 * @returns An object containing:
 * - `openPosition`: Function to open a new perpetual position
 * - `closePosition`: Function to close an existing position by ID
 *
 * @example
 * ```tsx
 * const { openPosition, closePosition } = usePerpTrade();
 *
 * const handleOpen = async () => {
 *   const result = await openPosition({
 *     ticker: 'AAPL',
 *     side: 'long',
 *     size: 100,
 *     leverage: 5
 *   });
 *   console.log('Position opened:', result.position.id);
 * };
 * ```
 */
export function usePerpTrade(options: UsePerpTradeOptions = {}) {
  const callApi = useCallback(
    async <T>(url: string, init: RequestInit = {}): Promise<T> => {
      const headers = new Headers(init.headers);
      headers.set('Content-Type', 'application/json');

      const token = await resolveToken(options.getAccessToken);
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }

      const response = await fetch(apiUrl(url), {
        ...init,
        headers,
      });

      const data = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        throw new Error(extractErrorMessage(data, response.status));
      }

      return data as T;
    },
    [options.getAccessToken]
  );

  const openPosition = useCallback(
    async (payload: OpenPerpPayload): Promise<OpenPerpResponse> => {
      return await callApi('/api/markets/perps/open', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    [callApi]
  );

  const closePosition = useCallback(
    async (positionId: string): Promise<ClosePerpResponse> => {
      return await callApi(`/api/markets/perps/position/${positionId}/close`, {
        method: 'POST',
      });
    },
    [callApi]
  );

  const previewOpenPosition = useCallback(
    async (
      payload: OpenPerpPreviewPayload,
      signal?: AbortSignal
    ): Promise<OpenPerpPreviewResponse> => {
      return await callApi('/api/markets/perps/preview', {
        method: 'POST',
        body: JSON.stringify(payload),
        signal,
      });
    },
    [callApi]
  );

  return {
    openPosition,
    closePosition,
    previewOpenPosition,
  };
}
