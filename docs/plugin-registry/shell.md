---
title: "Shell Plugin"
sidebarTitle: "Shell"
description: "Shell access plugin for Eliza — gives agents full access to the system shell. USE AT YOUR OWN RISK."
---

The Shell plugin gives Eliza agents direct access to the system shell, allowing them to execute arbitrary commands. **USE AT YOUR OWN RISK. THIS GIVES AI FULL ACCESS TO THE SYSTEM SHELL.**

**Package:** `@elizaos/plugin-shell` (core plugin — always loaded)

## Overview

This plugin exposes shell command execution to agents, enabling them to run system commands, scripts, and tools directly. It includes a configurable security model with command whitelists, blacklists, timeouts, and output size limits. Despite these controls, granting shell access to an AI agent carries inherent risk and should be configured carefully.

## Installation

This plugin is a core plugin and is always loaded. No manual installation is required.

## Auto-Enable

The plugin auto-enables when the `SHELL_ALLOWED_COMMANDS` environment variable is set, defining which commands the agent is permitted to run.

## Configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `SHELL_ALLOWED_COMMANDS` | string | No | Comma-separated whitelist of allowed commands |
| `SHELL_TIMEOUT_MS` | string | No | Maximum execution time in milliseconds |
| `SHELL_MAX_OUTPUT_SIZE` | string | No | Maximum output size in bytes |
| `SHELL_WORKING_DIR` | string | No | Default working directory |
| `SHELL_ENABLE_DANGEROUS` | boolean | No | Enable dangerous commands (`rm -rf`, etc.) |
| `SHELL_LOG_COMMANDS` | boolean | No | Log all executed commands |
| `SHELL_BLOCKED_COMMANDS` | string | No | Comma-separated blacklist of blocked commands |

Example configuration via environment variables:

```bash
export SHELL_ALLOWED_COMMANDS="ls,cat,grep,find,git"
export SHELL_TIMEOUT_MS="10000"
export SHELL_MAX_OUTPUT_SIZE="1048576"
export SHELL_WORKING_DIR="/home/user/project"
export SHELL_LOG_COMMANDS=true
```

## Security

- **Whitelist preferred over blacklist.** Use `SHELL_ALLOWED_COMMANDS` to restrict the agent to a known-safe set of commands rather than relying solely on `SHELL_BLOCKED_COMMANDS`.
- **Never enable `SHELL_ENABLE_DANGEROUS` in production.** This flag permits destructive commands like `rm -rf`.
- **Set timeouts and output limits** to prevent runaway processes and excessive memory usage.
- **Enable command logging** (`SHELL_LOG_COMMANDS=true`) for auditability.

## Related

- [Agent Orchestrator Plugin](/plugin-registry/agent-orchestrator) — Task-agent orchestration via PTY
- [Secrets (runtime)](/runtime/services#secrets-secrets-service) — Secure storage for sensitive configuration
