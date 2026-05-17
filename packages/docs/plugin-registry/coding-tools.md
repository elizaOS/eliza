---
title: "Coding Tools Plugin"
sidebarTitle: "Coding Tools"
description: "Native Claude-Code-style coding tools (Read, Write, Edit, Bash, Grep, Glob, and more) for elizaOS agents."
---

`@elizaos/plugin-coding-tools` provides filesystem, shell, and search primitives for Eliza agents: **READ**, **WRITE**, **EDIT**, **NOTEBOOK_EDIT**, **BASH** (with background **TASK_OUTPUT** / **TASK_STOP**), **GREP**, **GLOB**, **LS**, **WEB_FETCH**, **WEB_SEARCH**, **TODO_WRITE**, **ASK_USER_QUESTION**, **ENTER_WORKTREE**, and **EXIT_WORKTREE**. Paths must be absolute; operations are confined to configured workspace roots.

**Package:** `@elizaos/plugin-coding-tools`

## Overview

The plugin registers sandbox-oriented services (`FileStateService`, `SandboxService`, `SessionCwdService`, `RipgrepService`, `ShellTaskService`, `BashAstService`, `OsSandboxService`), an **AVAILABLE_CODING_TOOLS** provider, and the actions listed above. On unsupported platforms or when disabled, actions can be gated off entirely.

## Installation

```bash
eliza plugins install coding-tools
```

The plugin is included in the agent core plugin list (`CORE_PLUGINS`); install via CLI when adding it to a minimal or custom runtime layout.

## Disable

Set **`CODING_TOOLS_DISABLE`** to disable every action while the plugin remains loaded.

## Configuration

| Variable | Type | Required | Description |
|---|---|---|---|
| `CODING_TOOLS_WORKSPACE_ROOTS` | string | No | Comma-separated absolute paths the tools may access; defaults when unset follow runtime/workspace resolution |
| `CODING_TOOLS_DENY_COMMANDS` | string | No | Extra comma-separated command-prefix patterns **BASH** must refuse (merged with built-in deny rules) |
| `CODING_TOOLS_BASH_TIMEOUT_MS` | number | No | Default **BASH** timeout (ms); hard ceiling before backgrounding rules apply |
| `CODING_TOOLS_BASH_BG_BUDGET_MS` | number | No | Foreground budget (ms); longer runs return a `task_id` for **TASK_OUTPUT** |
| `CODING_TOOLS_MAX_READ_LINES` | number | No | Max lines **READ** returns in one call before truncation |
| `CODING_TOOLS_MAX_FILE_SIZE_BYTES` | number | No | Pre-stat size cap for **READ** |
| `CODING_TOOLS_GREP_HEAD_LIMIT` | number | No | Default match cap for **GREP** (`0` disables the limit) |
| `CODING_TOOLS_DISABLE` | boolean | No | Disable all plugin actions |

## Related

- [CLI Plugin](/plugin-registry/cli-plugin) — Command registration and interactive terminal sessions
- [MCP Plugin](/plugin-registry/mcp) — Connect to external MCP servers for extended tooling
