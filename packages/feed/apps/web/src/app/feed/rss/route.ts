/**
 * GET /feed/rss — RSS 2.0 feed of hot posts.
 *
 * WHY internal fetch: We reuse /api/feed/hot so filtering, scoring, and caching
 * live in one place; this route only converts JSON → RSS. No duplicate DB or business logic.
 * Cookie forwarded so optional auth on the API still applies (e.g. RLS); limit 50 for a full page of items.
 */

import { publicRateLimit } from '@feed/api';
import type { NextRequest } from 'next/server';
import {
  buildRssXml,
  getRssCacheHeaders,
  type RssChannel,
  type RssItem,
} from '@/lib/rss';

/** WHY: Behind a proxy we need x-forwarded-* to build absolute URLs for RSS <link> and <item> elements. */
function getOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedHost && forwardedProto) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  return new URL(request.url).origin;
}

export async function GET(request: NextRequest) {
  const { error } = await publicRateLimit(request);
  if (error) return error;

  const origin = getOrigin(request);
  const limit = 50;

  const res = await fetch(`${origin}/api/feed/hot?limit=${limit}`, {
    cache: 'no-store',
    headers: { cookie: request.headers.get('cookie') ?? '' },
  });

  if (!res.ok) {
    // WHY 502: Upstream API (our own) failed; caller should retry later.
    return new Response('Feed temporarily unavailable', { status: 502 });
  }

  const data = (await res.json()) as {
    success?: boolean;
    posts?: Array<{
      id: string;
      content: string;
      authorName: string;
      timestamp: string;
    }>;
  };

  const posts = data.posts ?? [];
  // WHY 80/500: Keep title and description short for RSS readers; full content is at link.
  const items: RssItem[] = posts.map((post) => ({
    title: `${post.authorName}: ${post.content.slice(0, 80)}${post.content.length > 80 ? '…' : ''}`,
    link: `${origin}/post/${post.id}`,
    description:
      post.content.slice(0, 500) + (post.content.length > 500 ? '…' : ''),
    pubDate: post.timestamp,
  }));

  const channel: RssChannel = {
    title: 'Feed Feed',
    link: `${origin}/feed`,
    description: 'Hot posts from Feed',
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
