---
title: "Agent Skills Plugin"
sidebarTitle: "Agent Skills"
description: "Agent Skills plugin for Eliza — implement the Agent Skills specification with progressive disclosure."
---

The Agent Skills plugin implements the Agent Skills specification for **elizaOS**, giving agents the ability to discover, load, and execute skills with progressive disclosure.

**Package:** `@elizaos/plugin-agent-skills` (core plugin — always loaded)

## Overview

Skills are self-contained capabilities that agents can acquire and invoke at runtime. The Agent Skills plugin manages the full skill lifecycle: discovery from a registry, installation into a local directory, auto-loading on startup, and runtime invocation. Progressive disclosure ensures that only relevant skills surface to the planner on each turn, keeping context focused.

## Installation

This plugin is a core plugin and is always loaded. No manual installation is required.

## Configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `SKILLS_DIR` | string | No | Directory to install and load skills from (default: `./skills`) |
| `SKILLS_AUTO_LOAD` | boolean | No | Automatically load installed skills on startup |
| `SKILLS_REGISTRY` | string | No | Skill registry URL (default: `https://clawhub.ai`) |
| `BUNDLED_SKILLS_DIRS` | string | No | Comma-separated list of directories containing bundled (read-only) skills |
| `OTTO_BUNDLED_SKILLS_DIR` | string | No | Legacy: Single directory containing Otto bundled skills |

Example in `eliza.json`:

```json
{
  "settings": {
    "SKILLS_DIR": "./skills",
    "SKILLS_AUTO_LOAD": true,
    "SKILLS_REGISTRY": "https://clawhub.ai"
  }
}
```

## Related

- [Agent Orchestrator Plugin](/plugin-registry/agent-orchestrator) — Task-agent orchestration
- [Plugin Manager Plugin](/plugin-registry/plugin-manager) — Dynamic plugin management
