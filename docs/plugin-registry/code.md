---
title: "Code Plugin"
sidebarTitle: "Code"
description: "A coder tools plugin for elizaOS that provides filesystem, shell, and git capabilities"
---

Filesystem, shell, and git capabilities for Milady agents to work with code.

**Package:** `@elizaos/plugin-code`

## Overview

The Code plugin equips elizaOS agents with developer tooling -- filesystem operations, shell command execution, and git integration. Agents can read and write files, run commands, and interact with version control within a configurable workspace. File access can be scoped by extension and size limits for safety.

## Installation

```bash
milady plugins install code
```

## Auto-Enable

The plugin auto-enables when `CODE_WORKSPACE_DIR` is set.

## Configuration

| Variable | Type | Required | Description |
|---|---|---|---|
| `CODE_WORKSPACE_DIR` | string | No | Workspace directory for code operations |
| `CODE_ALLOWED_EXTENSIONS` | string | No | Comma-separated list of allowed file extensions |
| `CODE_MAX_FILE_SIZE` | string | No | Maximum file size in bytes |

## Related

- [CLI Plugin](/plugin-registry/cli-plugin) - Command registration and interactive terminal sessions
- [MCP Plugin](/plugin-registry/mcp) - Connect to external MCP servers for extended tooling
