/**
 * Feed Layout Component
 *
 * Simple layout for the feed page. Includes RSS discovery so readers and
 * crawlers can find our feeds. WHY two mechanisms: metadata.alternates.types
 * is the canonical Next.js way (one primary feed); we also render two <link>
 * tags so both "Feed Feed" and "Feed Breaking News" are discoverable,
 * since Next metadata only allows one URL per MIME type.
 */
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';
export const revalidate = false;

export const metadata: Metadata = {
  alternates: {
    types: {
      'application/rss+xml': '/feed/rss',
    },
  },
};

export default function FeedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <link
        rel="alternate"
        type="application/rss+xml"
        title="Feed Feed"
        href="/feed/rss"
      />
      <link
        rel="alternate"
        type="application/rss+xml"
        title="Feed Breaking News"
        href="/feed/breaking-news/rss"
      />
      {children}
    </>
  );
}
