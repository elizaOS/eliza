/**
 * GET /feed/breaking-news/rss — RSS 2.0 feed of breaking news (world events, org updates, actor posts).
 *
 * WHY internal fetch: Same as /feed/rss — we call the existing breaking-news widget API and convert
 * to RSS so all aggregation and RLS logic stays in one place. Limit 20 keeps the feed focused.
 */

import { publicRateLimit } from '@babylon/api';
import type { NextRequest } from 'next/server';
import {
  buildRssXml,
  getRssCacheHeaders,
  type RssChannel,
  type RssItem,
} from '@/lib/rss';

/** WHY: Absolute origin needed for RSS item links (see feed/rss/route). */
function getOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedHost && forwardedProto) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  return new URL(request.url).origin;
}

interface BreakingNewsItem {
  id: string;
  title: string;
  description?: string;
  fullDescription?: string;
  timestamp: string;
  relatedQuestion?: number;
  relatedActorId?: string;
  relatedOrganizationId?: string;
}

export async function GET(request: NextRequest) {
  const { error } = await publicRateLimit(request);
  if (error) return error;

  const origin = getOrigin(request);
  const limit = 20;

  const res = await fetch(
    `${origin}/api/feed/widgets/breaking-news?limit=${limit}`,
    {
      cache: 'no-store',
      headers: { cookie: request.headers.get('cookie') ?? '' },
    }
  );

  if (!res.ok) {
    return new Response('Breaking news feed temporarily unavailable', {
      status: 502,
    });
  }

  const data = (await res.json()) as {
    success?: boolean;
    news?: BreakingNewsItem[];
  };

  const news = data.news ?? [];
  const items: RssItem[] = news.map((item) => {
    // WHY: Posts have relatedActorId and id = post id → link to /post/{id}. World events have no relatedActorId → link to /feed.
    const link =
      item.relatedActorId && item.id
        ? `${origin}/post/${item.id}`
        : `${origin}/feed`;
    return {
      title: item.title,
      link,
      description: item.fullDescription ?? item.description ?? '',
      pubDate: item.timestamp,
    };
  });

  const channel: RssChannel = {
    title: 'Babylon Breaking News',
    link: `${origin}/feed`,
    description: 'World events, price updates, and posts from Babylon',
    siteUrl: origin,
  };

  const xml = buildRssXml(channel, items);

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      ...getRssCacheHeaders(),
    },
  });
}
