'use client';

import type { PredictionMarketData, PredictionsTagData } from '@feed/shared';
import { cn } from '@feed/shared';
import { CheckCircle, Clock, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PredictionProbabilityChart } from '@/components/markets/PredictionProbabilityChart';
import { PredictionTradingModal } from '@/components/markets/PredictionTradingModal';
import { Switch } from '@/components/ui/switch';
import { usePredictionHistory } from '@/hooks/usePredictionHistory';
import type { MarketTimeRange, PredictionMarket } from '@/types/markets';
import { PanelViewMoreLink } from './PanelViewMoreLink';

interface PredictionsPanelProps {
  data: PredictionsTagData;
}

/** Convert tag prediction data to PredictionMarket format for modal */
function toPredictionMarket(
  prediction: PredictionMarketData
): PredictionMarket {
  return {
    id: prediction.id,
    text: prediction.question,
    status: prediction.resolved ? 'resolved' : 'active',
    resolutionDate: prediction.endDate,
    resolvedOutcome:
      prediction.resolution === 'YES'
        ? true
        : prediction.resolution === 'NO'
          ? false
          : undefined,
    scenario: 0,
    yesShares: prediction.yesShares,
    noShares: prediction.noShares,
  };
}

type TradeSide = 'YES' | 'NO';

interface TradingState {
  market: PredictionMarket;
  side: TradeSide;
}

export function PredictionsPanel({ data }: PredictionsPanelProps) {
  const [tradingState, setTradingState] = useState<TradingState | null>(null);
  const [timeRange, setTimeRange] = useState<MarketTimeRange>('1D');
  const [showClosed, setShowClosed] = useState(false);

  // Fetch history for single prediction view
  const marketId = data.prediction ? String(data.prediction.id) : null;
  const { history, loading: historyLoading } = usePredictionHistory(marketId, {
    limit: 100,
    range: timeRange,
    seed: data.prediction
      ? {
          yesShares: data.prediction.yesShares,
          noShares: data.prediction.noShares,
        }
      : undefined,
  });

  // Calculate live probability from history data
  const liveData = useMemo(() => {
    if (history.length === 0) {
      return null;
    }
    // Non-null assertion is safe here because history.length > 0
    const last = history[history.length - 1]!;

    // yesPrice is 0-1, convert to percentage
    const yesPercent = Math.round(last.yesPrice * 100);
    const noPercent = 100 - yesPercent;

    return { yesPercent, noPercent };
  }, [history]);

  // Handle single prediction view
  if (data.prediction) {
    const prediction = data.prediction;
    // Use live data from chart if available, otherwise fall back to tag data
    const displayYesPercent = liveData?.yesPercent ?? prediction.yesPercent;
    const displayNoPercent = liveData?.noPercent ?? prediction.noPercent;

    const predictionMarket = toPredictionMarket(prediction);

    return (
      <div className="p-4">
        {/* Question Header */}
        <div className="mb-4">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="font-semibold text-sm">Prediction Market</h3>
            {prediction.daysUntil !== null && !prediction.resolved && (
              <span className="flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-muted-foreground text-xs">
                <Clock size={12} />
                {prediction.daysUntil > 0
                  ? `${prediction.daysUntil}d left`
                  : 'Ending soon'}
              </span>
            )}
          </div>
          <p className="font-medium text-foreground">{prediction.question}</p>
        </div>

        {/* Odds Display */}
        <div className="mb-4 grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-green-600/15 p-4">
            <div className="mb-1 text-green-600 text-xs">YES</div>
            <div className="font-bold text-3xl text-green-600">
              {displayYesPercent}%
            </div>
          </div>
          <div className="rounded-lg bg-red-600/15 p-4">
            <div className="mb-1 text-red-600 text-xs">NO</div>
            <div className="font-bold text-3xl text-red-600">
              {displayNoPercent}%
            </div>
          </div>
        </div>

        {/* Probability Chart */}
        <div className="mb-4">
          {historyLoading && history.length === 0 ? (
            <div className="h-[200px] animate-pulse rounded-lg bg-muted/30" />
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <PredictionProbabilityChart
                data={history}
                marketId={String(prediction.id)}
                timeRange={timeRange}
                onTimeRangeChange={setTimeRange}
              />
            </div>
          )}
        </div>

        {/* Progress Bar */}
        <div className="mb-4">
          <div className="flex overflow-hidden rounded-full bg-muted">
            <div
              className="h-3 bg-green-500 transition-all"
              style={{ width: `${displayYesPercent}%` }}
            />
            <div
              className="h-3 bg-red-500 transition-all"
              style={{ width: `${displayNoPercent}%` }}
            />
          </div>
        </div>

        {/* Resolution Status */}
        {prediction.resolved ? (
          <div
            className={cn(
              'mb-4 rounded-lg p-3 text-center font-semibold',
              prediction.resolution === 'YES'
                ? 'bg-green-600/15 text-green-600'
                : prediction.resolution === 'NO'
                  ? 'bg-red-600/15 text-red-600'
                  : 'bg-muted text-muted-foreground'
            )}
          >
            Resolved: {prediction.resolution}
          </div>
        ) : (
          /* Trade Buttons */
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() =>
                setTradingState({ market: predictionMarket, side: 'YES' })
              }
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-green-600 py-3 font-bold text-sm text-white transition-colors hover:bg-green-700"
            >
              <CheckCircle size={18} />
              BUY YES
            </button>
            <button
              type="button"
              onClick={() =>
                setTradingState({ market: predictionMarket, side: 'NO' })
              }
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-600 py-3 font-bold text-sm text-white transition-colors hover:bg-red-700"
            >
              <XCircle size={18} />
              BUY NO
            </button>
          </div>
        )}

        {/* View Full Page Link */}
        <div className="mt-4">
          <PanelViewMoreLink href={`/markets/predictions/${prediction.id}`}>
            View full market page
          </PanelViewMoreLink>
        </div>

        {/* Trading Modal */}
        {tradingState && (
          <PredictionTradingModal
            question={tradingState.market}
            isOpen={!!tradingState}
            onClose={() => setTradingState(null)}
            defaultSide={tradingState.side}
          />
        )}
      </div>
    );
  }

  // Handle list view
  const { predictions: allPredictions, status } = data;

  if (!allPredictions || allPredictions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-muted-foreground text-sm">
          No predictions available
        </p>
      </div>
    );
  }

  const openPredictions = allPredictions.filter((p) => !p.resolved);
  const closedPredictions = allPredictions.filter((p) => p.resolved);
  const predictions = showClosed
    ? [...openPredictions, ...closedPredictions]
    : openPredictions;

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">
          {showClosed ? 'All Predictions' : 'Prediction Markets'}
        </h3>
        <div className="flex items-center gap-2">
          {status && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs capitalize">
              {status}
            </span>
          )}
          {closedPredictions.length > 0 && (
            <label className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <span>Show closed</span>
              <Switch
                checked={showClosed}
                onCheckedChange={setShowClosed}
                className="scale-75"
              />
            </label>
          )}
        </div>
      </div>
      {predictions.length === 0 ? (
        <div className="flex items-center justify-center py-4 text-muted-foreground text-xs">
          No open predictions
        </div>
      ) : (
        <div className="space-y-2">
          {predictions.map((prediction) => {
            const predictionMarket = toPredictionMarket(prediction);
            // Normalize percentages to ensure they sum to 100%
            const yesRaw = Number(prediction.yesPercent) || 0;
            const yesClamped = Math.max(0, Math.min(100, yesRaw));
            const noClamped = 100 - yesClamped;
            return (
              <div
                key={prediction.id}
                className={cn(
                  'rounded-lg border border-border bg-card p-3',
                  prediction.resolved && 'opacity-60'
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="line-clamp-2 font-medium text-sm">
                    {prediction.question}
                  </p>
                  {prediction.resolved && (
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-1.5 py-0.5 font-medium text-[10px] leading-none',
                        prediction.resolution === 'YES'
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                          : prediction.resolution === 'NO'
                            ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                            : 'bg-muted text-muted-foreground'
                      )}
                    >
                      {prediction.resolution === 'YES'
                        ? 'Yes'
                        : prediction.resolution === 'NO'
                          ? 'No'
                          : 'Cancelled'}
                    </span>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  {/* YES/NO bars */}
                  <div className="flex flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-2 bg-green-500"
                      style={{ width: `${yesClamped}%` }}
                    />
                    <div
                      className="h-2 bg-red-500"
                      style={{ width: `${noClamped}%` }}
                    />
                  </div>
                </div>
                <div className="mt-1.5 flex items-center justify-between text-xs">
                  <span className="text-green-500">
                    {Math.round(yesClamped)}% YES
                  </span>
                  <span className="text-red-500">
                    {Math.round(noClamped)}% NO
                  </span>
                </div>
                {!prediction.resolved && (
                  <div className="mt-2 flex items-center justify-between text-muted-foreground text-xs">
                    {prediction.daysUntil !== null ? (
                      <span>
                        {prediction.daysUntil > 0
                          ? `${prediction.daysUntil}d left`
                          : 'Ending soon'}
                      </span>
                    ) : (
                      <span>End: {prediction.endDate}</span>
                    )}
                  </div>
                )}
                {/* Quick Trade Button - only show for unresolved markets */}
                {!prediction.resolved && (
                  <button
                    type="button"
                    onClick={() =>
                      setTradingState({ market: predictionMarket, side: 'YES' })
                    }
                    className="mt-2 w-full rounded bg-primary/10 py-1.5 font-medium text-primary text-xs transition-colors hover:bg-primary/20"
                  >
                    Trade
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* View All Predictions Link */}
      <PanelViewMoreLink href="/markets">View all markets</PanelViewMoreLink>

      {/* Trading Modal */}
      {tradingState && (
        <PredictionTradingModal
          question={tradingState.market}
          isOpen={!!tradingState}
          onClose={() => setTradingState(null)}
          defaultSide={tradingState.side}
        />
      )}
    </div>
  );
}
