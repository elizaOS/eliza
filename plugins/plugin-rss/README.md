# @elizaos/plugin-rss

RSS and Atom feed integration plugin for ElizaOS. Enables AI agents to fetch, parse, and monitor news feeds with automatic periodic updates.

## Features

- **RSS Feed Fetching**: Download and parse RSS/Atom feeds from any URL
- **Feed Subscription Management**: Subscribe/unsubscribe to feeds for automatic monitoring
- **Periodic Feed Checking**: Automatically checks subscribed feeds every 15 minutes for new items
- **Feed Item Storage**: Automatically stores feed items in memory with duplicate detection
- **Feed Provider**: Makes feed items available to the agent's context
- **URL Extraction**: Smart URL extraction from natural language
- **Environment Configuration**: Auto-subscribe to feeds via environment variables

## Installation

```bash
npm install @elizaos/plugin-rss
```

Or with bun:

```bash
bun add @elizaos/plugin-rss
```

## Usage

Add the plugin to your ElizaOS agent configuration:

```typescript
import { rssPlugin } from '@elizaos/plugin-rss';

const agent = {
  // ... other configuration
  plugins: [rssPlugin],
};
```

## Configuration

### Environment Variables

Configure the plugin behavior through environment variables:

```bash
# Auto-subscribe to feeds on startup (JSON array or comma-separated)
RSS_FEEDS='["https://example.com/rss","https://news.com/feed"]'
# or
RSS_FEEDS='https://example.com/rss,https://news.com/feed'

# Disable subscription management actions (default: false)
RSS_DISABLE_ACTIONS=true

# Feed output format in context (default: csv)
# Options: 'csv' (compact, token-efficient) or 'markdown' (human-readable)
RSS_FEED_FORMAT=csv

# Future: Configure check interval in minutes (default: 15)
# RSS_CHECK_INTERVAL_MINUTES=30
```

## Actions

### GET_NEWSFEED

Downloads, parses, and auto-subscribes to an RSS feed.

**Example Usage:**
- "Read https://example.com/feed.rss"
- "Fetch the RSS feed at https://news.example.com/rss"

The action will:
1. Extract RSS URLs from the message
2. Fetch and parse the feed
3. Store new feed items in memory (table: `feeditems`)
4. Auto-subscribe to the feed for periodic updates
5. Report the number of articles downloaded

**Duplicate Detection:** Uses both GUID and title+pubDate to avoid duplicate items.

### SUBSCRIBE_RSS_FEED

Subscribe to an RSS feed for automatic periodic monitoring.

**Example Usage:**
- "Subscribe to https://example.com/feed.rss"
- "Add this feed: https://news.ycombinator.com/rss"

The action will:
1. Validate the RSS feed URL
2. Fetch the feed to verify it's valid
3. Store the subscription in memory (table: `feedsubscriptions`)
4. Confirm subscription with feed details

### UNSUBSCRIBE_RSS_FEED

Unsubscribe from an RSS feed.

**Example Usage:**
- "Unsubscribe from https://example.com/feed.rss"
- "Remove this feed: https://news.example.com/rss"

### LIST_RSS_FEEDS

List all currently subscribed RSS feeds.

**Example Usage:**
- "What RSS feeds am I subscribed to?"
- "Show me my feeds"
- "List my RSS subscriptions"

Returns information about each feed including:
- Feed title and URL
- Last check time
- Number of items in last check

**Note:** Actions can be disabled via `RSS_DISABLE_ACTIONS=true` environment variable.

## Providers

### FEEDITEMS

Provides access to recently fetched feed items from the memory store in the agent's context.

**Features:**
- Retrieves items from `feeditems` memory table
- Sorts by date (most recent first)
- Limits to 50 most recent items to optimize context size
- Configurable output format (CSV or Markdown)
- Groups items by feed source for better organization

**Output Format:**

Controlled by `RSS_FEED_FORMAT` environment variable (default: `csv`):

**CSV Format (default, recommended for token efficiency):**
```
# RSS Feed Items (50 from 3 feeds)
Feed,Title,URL,Published,Description
"Hacker News","New AI Model Released","https://...","2024-01-15","Description..."
"TechCrunch","Startup Raises $10M","https://...","2024-01-15","Description..."
```

**Markdown Format (human-readable, uses more tokens):**
Organized by feed with full metadata:
- Feed name and item count
- Article title and URL
- Publication date
- Author (if available)
- Description (truncated to 200 chars)

**Data Object:**
```typescript
{
  items: Memory[],           // Array of feed item memories
  count: number,             // Number of items returned (max 50)
  totalCount: number,        // Total items in memory
  feedCount: number,         // Number of unique feeds
}
```

**Use Case:**
The provider automatically injects recent news articles into the agent's context, allowing the agent to reference current news and information when responding to queries. Use CSV format for token economy, Markdown for better readability during development.

## Services

### RSS Service

The core service that handles:
- Fetching RSS/Atom feeds via HTTP
- Parsing XML into structured JSON
- Managing feed subscriptions
- Periodic feed checking (every 15 minutes by default)
- Duplicate detection and deduplication
- Loading feeds from environment configuration

**Service Type:** `RSS`

**Periodic Checking:**
The service automatically creates a task that checks all subscribed feeds every 15 minutes. New items are stored in the `feeditems` memory table.

**Memory Tables:**
- `feedsubscriptions`: Stores feed subscription information
- `feeditems`: Stores individual feed items with metadata

## Architecture

The plugin follows ElizaOS plugin architecture:

- **Actions**: Define what the agent can do with RSS feeds
- **Providers**: Supply feed data to the agent's context
- **Services**: Handle the core RSS fetching and parsing logic
- **Types**: Centralized type definitions for RSS data structures

### Exported Types

The plugin exports TypeScript types for use in your code:

```typescript
import type {
  RssChannel,
  RssItem,
  RssFeed,
  FeedItemMetadata,
  FeedSubscriptionMetadata,
} from '@elizaos/plugin-rss';
```

- `RssChannel`: RSS feed channel metadata
- `RssItem`: Individual RSS feed item (article/post)
- `RssFeed`: Complete feed (channel + items)
- `FeedItemMetadata`: Metadata stored with feed items in memory
- `FeedSubscriptionMetadata`: Metadata stored with feed subscriptions

## Development

```bash
# Build the plugin
bun run build

# Run in development mode
bun run dev

# Run tests
bun run test

# Format code
bun run format
```

## License

MIT

