import { withErrorHandling } from '@babylon/api';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const WIDGET_KEYS = [
  'trending',
  'markets',
  'stats',
  'trendingPosts',
  'breakingNews',
  'upcomingEvents',
] as const;

const WIDGET_ROUTES: Record<(typeof WIDGET_KEYS)[number], string> = {
  trending: '/api/feed/widgets/trending',
  markets: '/api/feed/widgets/markets',
  stats: '/api/feed/widgets/stats',
  trendingPosts: '/api/feed/widgets/trending-posts',
  breakingNews: '/api/feed/widgets/breaking-news',
  upcomingEvents: '/api/feed/widgets/upcoming-events',
};

async function fetchWidget(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  if (!response.ok) {
    throw new Error(`Widget request failed: ${path} (${response.status})`);
  }

  return response.json();
}

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (request: NextRequest) => {
  const origin = request.nextUrl.origin;

  const results = await Promise.allSettled(
    WIDGET_KEYS.map((key) => fetchWidget(origin, WIDGET_ROUTES[key]))
  );

  const widgets: Record<string, unknown> = {};
  for (const [i, key] of WIDGET_KEYS.entries()) {
    const result = results[i];
    widgets[key] = result?.status === 'fulfilled' ? result.value : null;
  }

  return NextResponse.json({
    success: true,
    widgets,
  });
});
