# Moltbook Auto Post

Automatic posting to Moltbook with intelligent content generation and rate limiting compliance.

## Overview

This skill automates posting to the Moltbook social platform. It generates content using configurable templates and topics, respects platform rate limits, and logs all activity.

## Usage

```bash
node skills/moltbook-auto-post/post.js
```

Typically invoked via a cron job on a schedule (e.g. every 6 hours).

## Configuration

Edit `config.json` in this directory:

- `moltbook.apiBase` — Moltbook API base URL
- `moltbook.accessToken` — Your Moltbook access token (or set `MOLTBOOK_TOKEN` env var)
- `moltbook.profileId` — Your Moltbook profile/user ID
- `rateLimit.minIntervalMinutes` — Minimum minutes between posts (default: 180)
- `rateLimit.maxPostsPerDay` — Maximum posts in a 24h window (default: 6)
- `content.topics` — Array of topic keywords for content generation
- `content.templateDir` — Path to post templates (relative to skill root)
- `content.style` — Writing style: "casual", "professional", "creative"
- `content.maxLength` — Maximum post character length

## Rate Limiting

The script enforces two layers of rate limiting:
1. **Minimum interval** — Won't post if the last post was too recent
2. **Daily cap** — Won't exceed the configured max posts per day

Post history is tracked in `post-history.json`.

## Templates

Place `.md` or `.txt` template files in the `templates/` subdirectory. The script picks a random template and fills in topic-specific content. If no templates exist, it generates freeform content.

## Logs

Activity is logged to `post.log` (rotated daily, kept for 7 days).

## Dependencies

Requires `node-fetch` (v3+) and `dayjs`. Install via:

```bash
cd skills/moltbook-auto-post && npm install
```
