# Firecrawl Plugin

## Purpose

A service wrapper for the Firecrawl API that provides web scraping and crawling functionality.

## Key Features

- Service Factory: Creates a service instance with API key
- Web Scraping (getScrapeData): Fetches content from a single webpage
- Web Searching (getSearchData): Searches for data based on conversations

## Configuration

Add to your character file:

```json
{
  "FIRECRAWL_API_KEY": "your-api-key-here"
}
```

## Example Usage

### Web Scraping

- "Can you scrape the content from https://example.com?"
- "Get the data from www.example.com/page"

### Web Search

- "Find the latest news about SpaceX launches"
- "Can you find details about the iPhone 16 release?"

## Actions

- FIRECRAWL_GET_SCRAPED_DATA: For single-page content extraction
- WEB_SEARCH: Web search for any data
