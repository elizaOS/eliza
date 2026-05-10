---
title: "RSS Plugin"
sidebarTitle: "RSS"
description: "RSS and news feed support for Eliza — subscribe to feeds and surface new content to agents."
---

The RSS plugin adds news and feed support to Eliza agents.

**Package:** `@elizaos/plugin-rss`

## Overview

This plugin lets agents subscribe to RSS feeds and receive new content as it is published. Agents can monitor news sources, blogs, and other syndicated content, then summarize or act on new items. Feeds are polled on a configurable interval.

## Installation

```bash
eliza plugins install rss
```

## Auto-Enable

Auto-enables when `RSS_FEEDS` is set.

## Configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `RSS_FEEDS` | string | No | Comma-separated list of RSS feed URLs |
| `RSS_POLL_INTERVAL` | string | No | Poll interval in minutes |

Set via environment variables or in your agent configuration:

```bash
export RSS_FEEDS="https://example.com/feed.xml,https://blog.example.com/rss"
export RSS_POLL_INTERVAL="15"
```

## Related

- [Knowledge Plugin](/plugin-registry/documents) — Store and query ingested content
- [Cron Plugin](/plugin-registry/cron) — Schedule recurring agent tasks
