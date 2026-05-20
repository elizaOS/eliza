/**
 * RSS 2.0 builder for outbound feeds.
 *
 * Single helper used by GET /feed/rss and GET /feed/breaking-news/rss so we
 * don't duplicate XML generation or cache semantics. WHY: One implementation
 * means consistent escaping, dates, and cache headers across all RSS endpoints.
 */

export interface RssChannel {
  title: string;
  link: string;
  description: string;
  siteUrl?: string;
}

export interface RssItem {
  title: string;
  link?: string;
  description?: string;
  pubDate: string; // ISO or RFC 1123
}

/** WHY: 5 min balances RSS reader polling (often 30min–2hr) with freshness; avoids hammering origin. */
const RSS_CACHE_MAX_AGE_SECONDS = 300;

/**
 * Escape text for use inside XML character data (title, description).
 * WHY: Unescaped <, >, & in user content would break the XML or allow injection.
 */
function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Format a date for RSS (RFC 1123).
 * WHY: RSS 2.0 spec expects pubDate in RFC 1123; readers parse it reliably.
 */
function toRfc1123(date: Date): string {
  return date.toUTCString();
}

/**
 * Build RSS 2.0 XML string from channel metadata and items.
 * Includes atom:link self so readers can discover the feed URL. WHY: Standard for self-referential feeds.
 */
export function buildRssXml(channel: RssChannel, items: RssItem[]): string {
  const now = new Date();
  const lastBuildDate = toRfc1123(now);

  const channelTitle = escapeXml(channel.title);
  const channelLink = escapeXml(channel.link);
  const channelDesc = escapeXml(channel.description);

  const itemElements = items
    .map((item) => {
      const title = escapeXml(item.title);
      const link = item.link ? escapeXml(item.link) : channelLink;
      const description = item.description ? escapeXml(item.description) : '';
      const pubDate = item.pubDate.includes(',')
        ? item.pubDate
        : toRfc1123(new Date(item.pubDate));

      return `    <item>
      <title>${title}</title>
      <link>${link}</link>
      <pubDate>${pubDate}</pubDate>
      ${description ? `<description>${description}</description>` : ''}
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${channelTitle}</title>
    <link>${channelLink}</link>
    <description>${channelDesc}</description>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <atom:link href="${channelLink}" rel="self" type="application/rss+xml" />
${itemElements}
  </channel>
</rss>`;
}

/**
 * Cache-Control header value for RSS responses (public, 5 min).
 * WHY: Public so CDNs/proxies can cache; s-maxage so edge caches respect it too.
 */
export function getRssCacheHeaders(): Record<string, string> {
  return {
    'Cache-Control': `public, max-age=${RSS_CACHE_MAX_AGE_SECONDS}, s-maxage=${RSS_CACHE_MAX_AGE_SECONDS}`,
  };
}
