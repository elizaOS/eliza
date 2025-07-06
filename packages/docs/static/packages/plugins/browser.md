# @elizaos/plugin-browser

## Purpose

Browser automation plugin for Eliza OS that provides web scraping and browser automation capabilities using Playwright.

## Key Features

- Browser Automation: Web scraping and content extraction with Playwright
- Multiple Browser Support: Works with Chromium, Firefox, and WebKit
- Headless Mode: Support for both headless and headed browser operations
- Page Interaction: Automated form filling, clicking, and navigation
- Content Extraction: HTML parsing and data extraction
- Screenshot Capture: Page and element screenshot capabilities
- Network Handling: Request interception and network monitoring

## Installation

```bash
bun install @elizaos/plugin-browser
```

## Configuration

The plugin may require environment variables:

```env
CAPSOLVER_API_KEY=your_capsolver_api_key  # Optional: For CAPTCHA solving capabilities
```

## Integration

```typescript
import { createBrowserPlugin } from '@elizaos/plugin-browser';

// Initialize the plugin
const browserPlugin = createBrowserPlugin();

// Register with Eliza OS
elizaos.registerPlugin(browserPlugin);
```

## Example Usage

The BrowserService provides:

- Page navigation and interaction
- Form filling and submission
- Content extraction and parsing
- Screenshot capture
- Network request handling
- CAPTCHA solving (with appropriate configuration)
