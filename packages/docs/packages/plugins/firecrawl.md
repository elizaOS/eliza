# Firecrawl Plugin

We've created a service wrapper for the Firecrawl API that provides two main functionalities: web scraping and crawling. Here's a breakdown of how it works:

## Core Features

1. **Service Factory**
   * Creates a service instance using an API key
   * Returns an object with two methods: `getScrapeData` and `getCrawlData`

2. **Web Scraping (`getScrapeData`)**
   * Fetches and extracts content from a single webpage
   * Returns structured data including page content and metadata
   * Endpoint: `https://api.firecrawl.dev/v1/scrape`

3. **Web Searching (`getSearchData`)**
   * Searches for data based on conversations
   * Endpoint: `https://api.firecrawl.dev/v1/search`

## Configuration

The plugin requires minimal configuration. In your character file, simply add:

```json
{
    "FIRECRAWL_API_KEY": "your-api-key-here"
}
```

## Usage Examples

### Web Scraping

The plugin recognizes various ways users might request web scraping:

```typescript
// Single URL request
"Can you scrape the content from https://example.com?"
"Get the data from www.example.com/page"

// Two-step interaction
User: "I need to scrape some website data."
Agent: "I can help you scrape website data. Please share the URL you'd like me to process."
User: "example.com/products"
```

### Web Search

The plugin handles different crawling request patterns:

```typescript
// Direct search
"Find the latest news about SpaceX launches"
"Can you find details about the iPhone 16 release?"
```

## Response Handling

The plugin automatically:
- Validates URLs before processing
- Handles both direct and conversational requests
- Provides appropriate feedback during the scraping/crawling process
- Returns structured data from the target website

## Error Handling

The plugin includes built-in error handling for common scenarios:
- Invalid or missing URLs
- API authentication issues
- Network failures
- Malformed responses

## Actions

The plugin provides two main actions:
- `FIRECRAWL_GET_SCRAPED_DATA`: For single-page content extraction
- `WEB_SEARCH`: Web search for any data

## Security

- API keys should be kept secure and never shared
- All requests are made over HTTPS
- Input validation is performed on all URLs before processing


