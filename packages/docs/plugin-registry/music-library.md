---
title: "Music Library Plugin"
sidebarTitle: "Music Library"
description: "Music metadata, library storage, playlists, user preferences, analytics, and YouTube integration"
---

Music metadata management with library storage and YouTube integration.

**Package:** `@elizaos/plugin-music-library`

## Overview

The Music Library plugin provides Eliza agents with music metadata handling, library storage, playlist management, user preference tracking, analytics, and YouTube search integration. It serves as the data layer for music-related agent workflows.

## Installation

```bash
eliza plugins install music-library
```

## Auto-Enable

This plugin auto-enables when the `YOUTUBE_API_KEY` environment variable is set.

## Configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `YOUTUBE_API_KEY` | string | No (sensitive) | YouTube Data API key for search |
