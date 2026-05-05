---
title: "Local DB Plugin"
sidebarTitle: "Local DB"
description: "Simple JSON-based local database storage for Eliza — no SQL, no migrations."
---

The Local DB plugin provides a simple, file-based database adapter for Eliza agents using JSON storage. No SQL engine, no migrations, no external dependencies.

**Package:** `@elizaos/plugin-localdb`

**Category:** Database

## Overview

This plugin implements the elizaOS database adapter interface using JSON files stored on the local filesystem. It provides lightweight persistence suitable for single-agent setups, development, and environments where running a full database server is unnecessary. Data is written to disk as plain JSON, making it easy to inspect and back up.

## Installation

```bash
eliza plugins install localdb
```

## Configuration

No environment variables or configuration required. The plugin works out of the box once installed.

## When to Use

- **Single-agent setups** — One agent running on a local machine
- **Development** — Inspect stored data directly by reading JSON files
- **Lightweight deployments** — No database server to configure or maintain
- **Backup-friendly** — Copy the JSON files to back up all agent state

## Comparison

| Feature | Local DB | In-Memory DB |
|---------|----------|-------------|
| Persistence | JSON files on disk | None |
| Speed | Fast | Fastest |
| Dependencies | Filesystem | None |
| Data survives restart | Yes | No |
