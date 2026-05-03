---
title: "In-Memory DB Plugin"
sidebarTitle: "In-Memory DB"
description: "Pure in-memory, ephemeral database storage for Eliza — no persistence, completely ephemeral."
---

The In-Memory DB plugin provides a pure in-memory database adapter for Eliza agents. All data is ephemeral and lost when the process exits.

**Package:** `@elizaos/plugin-inmemorydb`

**Category:** Database

## Overview

This plugin implements the elizaOS database adapter interface entirely in memory, with no disk I/O and no external dependencies. It is useful for testing, development, stateless agents, and scenarios where persistence is not needed or desired. All stored data is lost when the agent process terminates.

## Installation

```bash
eliza plugins install inmemorydb
```

## Configuration

No environment variables or configuration required. The plugin works out of the box once installed.

## When to Use

- **Testing** — Fast setup and teardown with no cleanup needed
- **Development** — Quick iteration without managing database files or servers
- **Stateless agents** — Agents that do not need to remember past interactions
- **Ephemeral sessions** — Short-lived agents where persistence adds no value

## Comparison

| Feature | In-Memory DB | Local DB |
|---------|-------------|----------|
| Persistence | None | JSON files on disk |
| Speed | Fastest | Fast |
| Dependencies | None | Filesystem |
| Data survives restart | No | Yes |
