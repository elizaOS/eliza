# @elizaos/plugin-web-search

## Purpose

A plugin for powerful web search capabilities, providing efficient search query handling and result processing through a customizable API interface.

## Key Features

- Execute web search queries with customizable parameters
- Process and format search results
- Handle search API authentication
- Manage token limits and response sizes
- Optimize query performance

## Installation

```bash
bun install @elizaos/plugin-web-search
```

## Configuration

The plugin requires the following environment variables:

```env
TAVILY_API_KEY=your_api_key    # Required: API key for search service
```

## Integration

Import and register the plugin in your Eliza configuration:

```typescript
import { webSearchPlugin } from '@elizaos/plugin-web-search';

export default {
  plugins: [webSearchPlugin],
  // ... other configuration
};
```

## Example Usage

```typescript
// Basic search
const searchQuery = 'Latest developments in quantum computing';
const results = await generateWebSearch(searchQuery, runtime);

// With formatted response
if (results && results.results.length) {
  const formattedResponse = `${results.answer}\n\nFor more details, check out:\n${results.results
    .map((result, index) => `${index + 1}. [${result.title}](${result.url})`)
    .join('\n')}`;
}
```
