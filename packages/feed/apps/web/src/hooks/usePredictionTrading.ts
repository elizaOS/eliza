'use client';

import { useCallback, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';

type PredictionTradeSide = 'YES' | 'NO';

type BuyPredictionInput = {
  marketId: string;
  side: PredictionTradeSide;
  amount: number;
};

type SellPredictionInput = {
  marketId: string;
  side: PredictionTradeSide;
  shares: number;
  positionId: string;
};

type BuyPredictionResult = {
  shares: number;
  avgPrice: number;
};

type SellPredictionResult = {
  pnl: number;
  remainingShares: number;
};

function readApiErrorMessage(payload: unknown, fallback: string): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof payload.error === 'object' &&
    payload.error !== null &&
    'message' in payload.error &&
    typeof payload.error.message === 'string'
  ) {
    return payload.error.message;
  }

  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof payload.error === 'string'
  ) {
    return payload.error;
  }

  if (
    typeof payload === 'object' &&
    payload !== null &&
    'message' in payload &&
    typeof payload.message === 'string'
  ) {
    return payload.message;
  }

  return fallback;
}

async function parseJsonPayload<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export function usePredictionTrading() {
  const { getAccessToken } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requireAccessToken = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      throw new Error('Authentication required. Please log in.');
    }

    return token;
  }, [getAccessToken]);

  const buyPrediction = useCallback(
    async (input: BuyPredictionInput): Promise<BuyPredictionResult> => {
      setLoading(true);
      setError(null);

      try {
        const accessToken = await requireAccessToken();

        const response = await fetch(
          `/api/markets/predictions/${input.marketId}/buy`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
              side: input.side.toLowerCase(),
              amount: input.amount,
            }),
          }
        );
        const payload = await parseJsonPayload<{
          position: { shares: number; avgPrice: number };
        }>(response);

        if (!response.ok) {
          throw new Error(readApiErrorMessage(payload, 'Failed to buy shares'));
        }

        return {
          shares: payload.position.shares,
          avgPrice: payload.position.avgPrice,
        };
      } catch (caughtError) {
        const message =
          caughtError instanceof Error
            ? caughtError.message
            : 'Prediction buy failed';
        setError(message);
        throw caughtError;
      } finally {
        setLoading(false);
      }
    },
    [requireAccessToken]
  );

  const sellPrediction = useCallback(
    async (input: SellPredictionInput): Promise<SellPredictionResult> => {
      setLoading(true);
      setError(null);

      try {
        const accessToken = await requireAccessToken();

        const response = await fetch(
          `/api/markets/predictions/${input.marketId}/sell`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
              shares: input.shares,
              positionId: input.positionId,
            }),
          }
        );
        const payload = await parseJsonPayload<{
          pnl: number;
          remainingShares: number;
        }>(response);

        if (!response.ok) {
          throw new Error(
            readApiErrorMessage(payload, 'Failed to sell shares')
          );
        }

        return {
          pnl: payload.pnl,
          remainingShares: payload.remainingShares,
        };
      } catch (caughtError) {
        const message =
          caughtError instanceof Error
            ? caughtError.message
            : 'Prediction sell failed';
        setError(message);
        throw caughtError;
      } finally {
        setLoading(false);
      }
    },
    [requireAccessToken]
  );

  return {
    buyPrediction,
    sellPrediction,
    loading,
    error,
  };
}
