# @elizaos/plugin-rss

RSS and Atom feed integration plugin for elizaOS. Enables agents to fetch, parse, and monitor news feeds across multiple languages.

## Features

- **Feed Fetching**: Fetch and parse RSS 2.0 and Atom feeds
- **Feed Subscription**: Subscribe to feeds for automatic monitoring
- **Periodic Updates**: Automatically check feeds on a configurable interval
- **Duplicate Detection**: Smart duplicate detection using GUIDs and title/date fallbacks
- **Multiple Output Formats**: CSV (compact) or Markdown (human-readable) output
- **Multi-Language Support**: Full implementations in TypeScript, Python, and Rust

## Installation

### TypeScript/Node.js

```bash
npm install @elizaos/plugin-rss
# or
bun add @elizaos/plugin-rss
```

### Python

```bash
pip install elizaos-plugin-rss
# or
cd python && pip install -e .
```

### Rust

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-rss = { path = "path/to/plugin-rss/rust" }
```

## Configuration

Set these environment variables to configure the plugin:

| Variable                     | Type    | Default | Description                                                       |
| ---------------------------- | ------- | ------- | ----------------------------------------------------------------- |
| `RSS_FEEDS`                  | string  | -       | JSON array or comma-separated list of feed URLs to auto-subscribe |
| `RSS_DISABLE_ACTIONS`        | boolean | `false` | Set to `true` to disable subscription management actions          |
| `RSS_FEED_FORMAT`            | string  | `csv`   | Output format: `csv` (compact) or `markdown` (readable)           |
| `RSS_CHECK_INTERVAL_MINUTES` | number  | `15`    | Interval in minutes between feed checks                           |

### Example Configuration

```bash
# JSON array format
RSS_FEEDS='["https://news.ycombinator.com/rss", "https://feeds.bbci.co.uk/news/rss.xml"]'

# Comma-separated format
RSS_FEEDS='https://news.ycombinator.com/rss,https://feeds.bbci.co.uk/news/rss.xml'

# Use markdown format for better readability
RSS_FEED_FORMAT='markdown'

# Check feeds every 30 minutes
RSS_CHECK_INTERVAL_MINUTES=30
```

## Usage

### TypeScript

```typescript
import { rssPlugin } from "@elizaos/plugin-rss";

// Add to your agent's plugins
const agent = new AgentRuntime({
  plugins: [rssPlugin],
  // ...
});
```

### Python

```python
from elizaos_plugin_rss import RssPlugin, RssClient

# Create a client
client = RssClient()

# Fetch a feed
feed = await client.fetch_feed("https://news.ycombinator.com/rss")
print(f"Feed: {feed.title}")
for item in feed.items:
    print(f"  - {item.title}")

# Use the plugin
plugin = RssPlugin()
```

### Rust

```rust
use elizaos_plugin_rss::{RssClient, RssConfig};

// Create a client
let config = RssConfig::default();
let client = RssClient::new(config)?;

// Fetch a feed
let feed = client.fetch_feed("https://news.ycombinator.com/rss").await?;
println!("Feed: {}", feed.title);
for item in &feed.items {
    println!("  - {}", item.title);
}
```

## Actions

The plugin provides these actions:

### GET_NEWSFEED

Download and parse an RSS/Atom feed from a URL.

**Example:**

```
User: Read https://news.ycombinator.com/rss
Agent: [GET_NEWSFEED] Downloaded 30 articles from "Hacker News"
```

### SUBSCRIBE_RSS_FEED

Subscribe to a feed for automatic monitoring.

**Example:**

```
User: Subscribe to https://news.ycombinator.com/rss
Agent: [SUBSCRIBE_RSS_FEED] Subscribed to "Hacker News"
```

### UNSUBSCRIBE_RSS_FEED

Unsubscribe from a feed.

**Example:**

```
User: Unsubscribe from https://news.ycombinator.com/rss
Agent: [UNSUBSCRIBE_RSS_FEED] Unsubscribed from feed
```

### LIST_RSS_FEEDS

List all subscribed feeds.

**Example:**

```
User: What feeds am I subscribed to?
Agent: [LIST_RSS_FEEDS] You have 3 subscribed feeds...
```

## Provider

### FEEDITEMS

Provides recent feed items to the agent's context. Items are formatted according to the `RSS_FEED_FORMAT` setting.

## Types

### RssChannel

```typescript
interface RssChannel {
  title: string;
  description: string;
  link: string;
  language: string;
  copyright: string;
  lastBuildDate: string;
  generator: string;
  docs: string;
  ttl: string;
  image: RssImage | null;
}
```

### RssItem

```typescript
interface RssItem {
  title: string;
  link: string;
  pubDate: string;
  description: string;
  author: string;
  category: string[];
  comments: string;
  guid: string;
  enclosure: RssEnclosure | null;
}
```

### RssFeed

```typescript
interface RssFeed extends RssChannel {
  items: RssItem[];
}
```

## Development

### Building

```bash
# Build all languages
bun run build

# Build specific language
bun run build:ts
bun run build:python
bun run build:rust
```

### Testing

```bash
# Test all languages
bun run test

# Test specific language
bun run test:ts
bun run test:python
bun run test:rust
```

### Linting

```bash
# Lint TypeScript
bun run lint

# Lint Python
bun run lint:python

# Lint Rust
bun run lint:rust
```

## Architecture

```
plugin-rss/
├── package.json          # Root package orchestrating all implementations
├── README.md
├── typescript/           # TypeScript implementation
│   ├── index.ts
│   ├── types.ts
│   ├── service.ts
│   ├── parser.ts
│   ├── actions/
│   └── providers/
├── python/               # Python implementation
│   ├── pyproject.toml
│   └── elizaos_plugin_rss/
│       ├── __init__.py
│       ├── types.py
│       ├── client.py
│       ├── parser.py
│       └── plugin.py
└── rust/                 # Rust implementation
    ├── Cargo.toml
    └── src/
        ├── lib.rs
        ├── types.rs
        ├── client.rs
        ├── parser.rs
        └── error.rs
```

## License

MIT © elizaOS Team
