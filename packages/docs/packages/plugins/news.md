# @elizaos/plugin-news

A plugin for fetching and handling real-time news data through NewsAPI integration.

## Overview

This plugin provides functionality to:
- Fetch latest news articles from NewsAPI
- Search news by specific topics or keywords
- Get article summaries including titles, descriptions, and URLs
- Limit results to most recent and relevant content

## Installation

```bash
npm install @elizaos/plugin-news
```

## Configuration

The plugin requires the following environment variable:

```env
NEWS_API_KEY=your_newsapi_key  # Required for accessing NewsAPI
```

## Usage

Import and register the plugin in your Eliza configuration:

```typescript
import { newsPlugin } from "@elizaos/plugin-news";

export default {
  plugins: [newsPlugin],
  // ... other configuration
};
```

## Features

### Current News Action

The plugin provides a `CURRENT_NEWS` action that responds to various news-related queries:

```typescript
// Example queries the action responds to:
"what's the latest news about <searchTerm>?"
"can you show me the latest news about <searchTerm>?"
"what's in the <searchTerm> news today?"
"show me current events about <searchTerm>?"
"what's going on in the world of <searchTerm>?"
"give me the latest headlines about <searchTerm>?"
"show me news updates about <searchTerm>?"
"what are today's top stories about <searchTerm>?"
```

The action returns up to 5 recent articles, including:
- Article title
- Description
- URL
- Content preview (up to 1000 characters)

## Development

### Building

```bash
npm run build
```

### Development Mode

```bash
npm run dev
```

### Linting

```bash
npm run lint
```

### Project Structure

```
plugin-news/
├── src/
│   ├── actions/        # Action implementations
│   │   ├── news.ts    # Current news action
│   │   └── index.ts   # Action exports
│   └── index.ts       # Main plugin export
├── package.json
└── tsconfig.json
```

## Dependencies

- `@ai16z/eliza`: Core Eliza framework
- `tsup`: Build tool for TypeScript packages
- Other standard dependencies listed in package.json

## API Reference

### Actions

- `CURRENT_NEWS`: Main action for fetching news
  - Aliases: `["NEWS", "GET_NEWS", "GET_CURRENT_NEWS"]`
  - Automatically extracts search terms from user messages
  - Returns formatted news articles with titles, descriptions, and URLs

### Response Format

```typescript
interface NewsResponse {
    title: string;
    description: string;
    url: string;
    content: string;  // Limited to 1000 characters
}
```

## Future Enhancements

1. **Additional News Sources**
   - Integration with multiple news APIs
   - RSS feed support
   - Social media news aggregation

2. **Content Analysis**
   - Sentiment analysis of news articles
   - Topic categorization
   - Trend detection
   - Fact-checking integration

3. **Customization Options**
   - User preferences for news sources
   - Custom filtering rules
   - Personalized news feeds
   - Language preferences

4. **Advanced Search**
   - Date range filtering
   - Source filtering
   - Category-based search
   - Advanced query syntax

5. **Performance Improvements**
   - Caching layer
   - Rate limiting optimization
   - Response compression
   - Batch processing

We welcome community feedback and contributions to help prioritize these enhancements.

## Contributing

Contributions are welcome! Please see the CONTRIBUTING.md file for more information.


## License

This plugin is part of the Eliza project. See the main project repository for license information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [NewsAPI](https://newsapi.org/): News data provider

Plugin generated from Eliza coding tutorial [Agent Dev School Part 2](https://www.youtube.com/watch?v=XenGeAcPAQo)
