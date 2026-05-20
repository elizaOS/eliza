'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  TickerNewsItem,
  TickerPerpItem,
  TickerPredictionItem,
  TickerResponse,
} from '@/types/ticker';

const DEFAULT_STREAMS = 'news,predictions,perps';
const DEFAULT_THEME = 'dark';
const DEFAULT_SPEED = 0.7;
const DEFAULT_HEIGHT = 48;

/** Speed param: 0.1 = slowest, 1 = medium, 3 = fastest. Clamped to [0.1, 3]. */
const SPEED_MIN = 0.1;
const SPEED_MAX = 3;

function useTickerParams() {
  if (typeof window === 'undefined') {
    return {
      streams: DEFAULT_STREAMS,
      theme: DEFAULT_THEME,
      speed: DEFAULT_SPEED,
      height: DEFAULT_HEIGHT,
    };
  }
  const params = new URLSearchParams(window.location.search);
  const raw = parseFloat(params.get('speed') || String(DEFAULT_SPEED));
  const speed = Math.min(
    SPEED_MAX,
    Math.max(SPEED_MIN, Number.isFinite(raw) ? raw : DEFAULT_SPEED)
  );
  return {
    streams: params.get('streams')?.trim() || DEFAULT_STREAMS,
    theme: (params.get('theme') || DEFAULT_THEME).toLowerCase(),
    speed,
    height: Math.min(
      120,
      Math.max(
        32,
        parseInt(params.get('height') || String(DEFAULT_HEIGHT), 10) ||
          DEFAULT_HEIGHT
      )
    ),
  };
}

type TickerItem = {
  key: string;
  label: string;
  text: string;
  type: 'news' | 'prediction' | 'perp';
  /** Perps only: 24h % change for red/green coloring */
  changePercent24h?: number | null;
  /** Predictions only: yes % for the meter (0–100) */
  yesPercent?: number;
};

function buildItems(response: TickerResponse): TickerItem[] {
  const items: TickerItem[] = [];
  (response.news ?? []).forEach((n: TickerNewsItem) => {
    items.push({
      key: `news-${n.id}`,
      label: 'News',
      text: n.title,
      type: 'news',
    });
  });
  (response.predictions ?? []).forEach((p: TickerPredictionItem) => {
    items.push({
      key: `pred-${p.id}`,
      label: 'Prediction',
      text: p.question,
      type: 'prediction',
      yesPercent: p.yesPercent,
    });
  });
  (response.perps ?? []).forEach((p: TickerPerpItem) => {
    const changeStr =
      p.changePercent24h == null
        ? '—'
        : `${p.changePercent24h >= 0 ? '+' : ''}${p.changePercent24h.toFixed(2)}%`;
    items.push({
      key: `perp-${p.ticker}`,
      label: 'Perp',
      text: `${p.ticker} $${p.price.toFixed(2)} (${changeStr})`,
      type: 'perp',
      changePercent24h: p.changePercent24h,
    });
  });
  return items;
}

function perpTextColor(
  changePercent24h: number | null | undefined,
  isDark: boolean
): string {
  if (changePercent24h == null || changePercent24h === 0) return '';
  if (changePercent24h > 0)
    return isDark ? 'rgb(34, 197, 94)' : 'rgb(22, 163, 74)'; // green-500 / green-600
  return isDark ? 'rgb(239, 68, 68)' : 'rgb(220, 38, 38)'; // red-500 / red-600
}

/** Semi-circular arc meter (0% left, 100% right), percentage centered inside. */
function PredictionArcMeter({
  percent,
  isDark,
  size = 36,
}: {
  percent: number;
  isDark: boolean;
  size?: number;
}) {
  const pct = Math.min(100, Math.max(0, percent));
  const r = 40;
  // Top half-circle: from (10,50) left to (90,50) right, counterclockwise
  const halfCircleLength = Math.PI * r;
  const filledLength = (pct / 100) * halfCircleLength;
  const trackColor = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.12)';
  const fillColor =
    pct > 50
      ? isDark
        ? 'rgb(34, 197, 94)'
        : 'rgb(22, 163, 74)' // green
      : isDark
        ? 'rgb(234, 88, 12)'
        : 'rgb(194, 65, 12)'; // orange-600 / orange-700 below 50%

  const h = (size * 60) / 100;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: h }}
    >
      <svg
        viewBox="0 0 100 60"
        className="absolute inset-0 block"
        style={{ width: size, height: h }}
        role="img"
        aria-label={`Prediction meter: ${Math.round(pct)}% yes`}
      >
        {/* Track: full semi-circle */}
        <path
          d="M 10 50 A 40 40 0 0 0 90 50"
          fill="none"
          stroke={trackColor}
          strokeWidth="10"
          strokeLinecap="round"
        />
        {/* Filled: partial arc from left (0%) to percent */}
        <path
          d="M 10 50 A 40 40 0 0 0 90 50"
          fill="none"
          stroke={fillColor}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${filledLength} ${halfCircleLength}`}
          strokeDashoffset={0}
        />
      </svg>
      <span
        className="relative font-bold text-[10px] tabular-nums leading-none"
        style={{ color: isDark ? '#fafafa' : '#0a0a0a' }}
      >
        {Math.round(pct)}%
      </span>
    </span>
  );
}

export function TickerClient() {
  const { streams, theme, speed, height } = useTickerParams();
  const [data, setData] = useState<TickerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTicker = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(
        `/api/ticker?streams=${encodeURIComponent(streams)}&limit=30`
      );
      if (!res.ok) throw new Error(`Ticker API ${res.status}`);
      const json = (await res.json()) as { success?: boolean } & TickerResponse;
      setData({
        news: json.news,
        predictions: json.predictions,
        perps: json.perps,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load ticker');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [streams]);

  useEffect(() => {
    fetchTicker();
    const interval = setInterval(fetchTicker, 60_000);
    return () => clearInterval(interval);
  }, [fetchTicker]);

  const isDark = theme === 'dark';
  const bg = isDark ? '#0a0a0a' : '#fff';
  const fg = isDark ? '#fafafa' : '#0a0a0a';
  const muted = isDark ? '#71717a' : '#52525b';
  // One full scroll cycle: speed 0.1 → 600s, 0.5 → 240s, 1 → 120s, 3 → 40s
  const duration = Math.min(600, Math.max(20, Math.round(120 / speed)));

  if (loading && !data) {
    return (
      <div
        className="flex w-full items-center justify-center font-sans text-sm"
        style={{ height: `${height}px`, background: bg, color: muted }}
      >
        Loading ticker…
      </div>
    );
  }

  if (error && !data) {
    return (
      <div
        className="flex w-full items-center justify-center font-sans text-sm"
        style={{ height: `${height}px`, background: bg, color: muted }}
      >
        {error}
      </div>
    );
  }

  const items = data ? buildItems(data) : [];
  if (items.length === 0) {
    return (
      <div
        className="flex w-full items-center justify-center font-sans text-sm"
        style={{ height: `${height}px`, background: bg, color: muted }}
      >
        No data yet
      </div>
    );
  }

  return (
    <div
      className="flex w-full items-center overflow-hidden font-sans"
      style={{
        height: `${height}px`,
        background: bg,
        color: fg,
      }}
    >
      <div
        className="flex shrink-0 items-center gap-8"
        style={{
          animation: `ticker-scroll ${duration}s linear infinite`,
        }}
      >
        {[...items, ...items].map((item, index) => {
          const textColor =
            item.type === 'perp'
              ? perpTextColor(item.changePercent24h, isDark) || fg
              : fg;
          const isPrediction =
            item.type === 'prediction' && item.yesPercent != null;
          const uniqueKey = index < items.length ? item.key : `${item.key}-dup`;
          return (
            <span
              key={uniqueKey}
              className="flex shrink-0 items-center gap-2 whitespace-nowrap text-sm"
            >
              <span
                className="rounded px-1.5 py-0.5 font-medium text-xs"
                style={{
                  background: isDark
                    ? 'rgba(255,255,255,0.12)'
                    : 'rgba(0,0,0,0.08)',
                  color: muted,
                }}
              >
                {item.label}
              </span>
              {isPrediction ? (
                <PredictionArcMeter
                  percent={item.yesPercent!}
                  isDark={isDark}
                  size={36}
                />
              ) : null}
              <span style={{ color: textColor }}>{item.text}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
