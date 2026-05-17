---
title: "Browser Plugin"
sidebarTitle: "Browser"
description: "Browser automation plugin for Eliza — web scraping, form submission, screenshot capture, and JavaScript execution."
---

The Browser plugin gives Eliza agents the ability to control a headless web browser — navigating pages, extracting content, filling forms, capturing screenshots, and executing JavaScript.

**Package:** `@elizaos/plugin-browser`

## Overview

The Browser plugin uses a headless browser (via stagehand-server and Puppeteer/Chromium) that agents can control programmatically. This enables agents to access any web content, interact with web applications, and perform research tasks that require JavaScript rendering.

## Installation

```bash
eliza plugins install @elizaos/plugin-browser
```

The plugin requires a running stagehand-server instance for browser automation.

## Enable via Features

```json
{
  "features": {
    "browser": true
  }
}
```

Or set in environment:

```bash
export ELIZA_FEATURE_BROWSER=true
```

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `OPENAI_API_KEY` | No* | OpenAI API key for AI-powered browser interactions |
| `ANTHROPIC_API_KEY` | No* | Anthropic API key for Claude-powered interactions |
| `BROWSER_HEADLESS` | No | Run browser in headless mode (default: `true`) |
| `BROWSERBASE_API_KEY` | No | API key for BrowserBase cloud browser service |
| `BROWSERBASE_PROJECT_ID` | No | Project ID for BrowserBase |
| `CAPSOLVER_API_KEY` | No | API key for CAPSolver automated CAPTCHA solving |

*At least one LLM API key (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`) is needed for content extraction.

```json
{
  "features": {
    "browser": {
      "enabled": true
    }
  }
}
```

## Actions

| Action | Description |
|--------|-------------|
| `BROWSE_WEB` | Navigate to a URL and extract the page content |
| `TAKE_SCREENSHOT` | Capture a screenshot of a URL |
| `FILL_FORM` | Fill and submit a web form |
| `CLICK_ELEMENT` | Click an element on a page |
| `EXTRACT_TEXT` | Extract text from a specific element |
| `RUN_JAVASCRIPT` | Execute JavaScript in the page context |
| `SEARCH_WEB` | Perform a web search and return results |
| `DOWNLOAD_FILE` | Download a file from a URL |

## Usage Examples

After the plugin is loaded:

> "Summarize the content at https://news.ycombinator.com"

> "Take a screenshot of https://example.com"

> "Search the web for the latest Node.js release"

> "Fill in the contact form at https://example.com/contact"

## Content Extraction

The plugin extracts clean, readable text from web pages by:

1. Navigating to the URL with the headless browser
2. Waiting for the page to fully load (including JavaScript)
3. Extracting the main content using Readability
4. Converting to Markdown for the LLM

This is significantly more reliable than HTTP fetch for JavaScript-rendered sites.

## Screenshot Capability

Screenshots are returned as base64-encoded images and can be passed to vision-capable models for analysis:

```typescript
// The agent can analyze screenshots automatically when vision is configured
const screenshot = await browser.screenshot("https://example.com");
const description = await runtime.useModel("IMAGE_DESCRIPTION", {
  image: screenshot,
  prompt: "Describe what you see on this webpage.",
});
```

## Security

The browser runs in a sandboxed context. Consider:

- Restricting allowed domains if the agent operates in untrusted environments
- Setting `browser.maxPages` to limit resource usage
- Using a proxy for IP privacy in scraping scenarios

## Related

- [Computer Use Plugin](/plugin-registry/computeruse) — Full desktop automation
- [Knowledge Plugin](/plugin-registry/documents) — Store extracted web content
- [Image Generation Plugin](/plugin-registry/image-generation) — Generate images
