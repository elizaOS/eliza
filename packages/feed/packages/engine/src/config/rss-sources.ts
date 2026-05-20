/**
 * Default RSS feed sources for news generation (inbound: we consume these feeds).
 *
 * WHY this file: "Where do we put RSS feed URLs?" should have one answer. This config
 * is the single place for the default list; bootstrap seeds rssFeedSources from it,
 * and the engine only reads from the DB at runtime. Add or edit sources here;
 * runtime enable/disable stays in DB (isActive) so we can turn feeds off without a deploy.
 */

export interface RssSourceConfig {
  name: string;
  feedUrl: string;
  category: string;
}

export const DEFAULT_RSS_SOURCES: RssSourceConfig[] = [
  // --- Tech (3 feeds — reduced from 7 to prevent tech domination) ---
  {
    name: 'TechCrunch',
    feedUrl: 'https://techcrunch.com/feed/',
    category: 'tech',
  },
  {
    name: 'Ars Technica',
    feedUrl: 'https://feeds.arstechnica.com/arstechnica/index',
    category: 'tech',
  },
  {
    name: 'The Verge',
    feedUrl: 'https://www.theverge.com/rss/index.xml',
    category: 'tech',
  },
  // --- Business & Finance (2 feeds) ---
  {
    name: 'New York Times - Business',
    feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',
    category: 'business',
  },
  // --- Crypto (1 feed — reduced from 2) ---
  {
    name: 'CoinDesk',
    feedUrl: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
    category: 'crypto',
  },
  // --- Science & Space (2 feeds — new) ---
  {
    name: 'NASA Breaking News',
    feedUrl: 'https://www.nasa.gov/news-release/feed/',
    category: 'science',
  },
  {
    name: 'New Scientist',
    feedUrl: 'https://www.newscientist.com/section/news/feed/',
    category: 'science',
  },
  // --- Politics & World (2 feeds — new) ---
  {
    name: 'BBC - World',
    feedUrl: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    category: 'politics',
  },
  {
    name: 'NPR - Politics',
    feedUrl: 'https://feeds.npr.org/1014/rss.xml',
    category: 'politics',
  },
  // --- Culture & Entertainment (1 feed — new) ---
  {
    name: 'BBC - Entertainment',
    feedUrl: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml',
    category: 'culture',
  },
];
