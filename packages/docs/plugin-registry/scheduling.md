---
title: "Scheduling Plugin"
sidebarTitle: "Scheduling"
description: "Scheduling and calendar coordination plugin for ElizaOS agents"
---

Calendar-aware scheduling and coordination for Eliza agents via Google Calendar.

**Package:** `@elizaos/plugin-scheduling`

## Overview

The Scheduling plugin integrates Google Calendar with elizaOS agents, enabling them to manage events, check availability, and coordinate scheduling on behalf of users. It uses OAuth credentials to access Google Calendar and supports reading, creating, and managing calendar events as part of agent workflows.

## Installation

```bash
eliza plugins install scheduling
```

## Auto-Enable

The plugin auto-enables when `GOOGLE_CALENDAR_CLIENT_ID` is set.

## Configuration

| Variable | Type | Required | Description |
|---|---|---|---|
| `GOOGLE_CALENDAR_CLIENT_ID` | string | Yes | Google Calendar OAuth client ID |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | string | Yes | Google Calendar OAuth client secret |
| `GOOGLE_CALENDAR_REDIRECT_URI` | string | No | OAuth redirect URI |
| `GOOGLE_CALENDAR_REFRESH_TOKEN` | string | Yes | Google Calendar refresh token |

All sensitive credentials (`CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN`) should be stored securely and never committed to version control.

## Related

- [Cron Plugin](/plugin-registry/cron) - Time-based task scheduling
