# @elizaos/plugin-news

## Purpose

A plugin for fetching and handling real-time news data through NewsAPI integration.

## Key Features

- Fetch latest news articles from NewsAPI
- Search news by specific topics or keywords
- Get article summaries including titles, descriptions, and URLs
- Limit results to most recent and relevant content

## Installation

```bash
bun install @elizaos/plugin-news
```

## Configuration

The plugin requires the following environment variable:

```env
NEWS_API_KEY=your_newsapi_key  # Required for accessing NewsAPI
```

## Integration

Import and register the plugin in your Eliza configuration:

```typescript
import { newsPlugin } from '@elizaos/plugin-news';

export default {
  plugins: [newsPlugin],
  // ... other configuration
};
```

## Example Usage

The `CURRENT_NEWS` action responds to queries like:

- "what's the latest news about `searchTerm`?"
- "show me current events about `searchTerm`?"
- "what's going on in the world of `searchTerm`?"

Returns up to 5 recent articles with title, description, URL, and content preview.

## Links

- [NewsAPI](https://newsapi.org/)
- [Agent Dev School Part 2](https://www.youtube.com/watch?v=XenGeAcPAQo)
