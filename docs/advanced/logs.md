---
title: Logs
sidebarTitle: Logs
description: View runtime and service logs for your Milady agent directly in the dashboard.
---

The Logs tab provides a real-time log viewer for your agent's runtime output. Access it from the **Advanced** section of the dashboard at `/logs`.

## Overview

The log viewer streams runtime logs directly in the browser, giving you visibility into agent operations without needing terminal access.

## Log Levels

Logs are color-coded by severity level:

| Level | Color | Description |
|-------|-------|-------------|
| **ERROR** | Red | Runtime errors and exceptions |
| **WARN** | Yellow | Warnings and potential issues |
| **INFO** | Default | General informational messages |
| **DEBUG** | Gray | Detailed debugging output |

## Filtering

Use the filter controls to narrow down log output:

- **Level filter** — show only logs at or above a specific severity level
- **Text search** — filter logs by keyword or pattern
- **Service filter** — narrow down to logs from a specific service or plugin

## Features

- **Auto-scroll** — the viewer automatically scrolls to show the latest log entries
- **Pause** — temporarily pause auto-scroll to inspect a specific log section
- **Copy** — copy individual log entries or selections to clipboard
- **Timestamp display** — each log entry includes a precise timestamp
