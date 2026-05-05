---
title: "Trajectory Logger Plugin"
sidebarTitle: "Trajectory Logger"
description: "Trajectory logging plugin for Eliza — capture agent interaction trajectories for debugging and RL training."
---

The Trajectory Logger plugin captures agent interaction trajectories, persisting them for debugging, analysis, and reinforcement-learning training workflows.

**Package:** `@elizaos/plugin-trajectory-logger` (core plugin — always loaded)

## Overview

Every agent turn is logged as a trajectory record by default. These trajectories feed into Eliza's native optimization and training pipelines (MIPRO, GEPA, bootstrap-fewshot), providing the raw data needed for prompt optimization and RL-based improvement. Trajectories are also invaluable for debugging agent behavior after the fact. Logging can be disabled when not needed.

## Installation

This plugin is a core plugin and is always loaded. No manual installation is required.

## Configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ELIZA_DISABLE_TRAJECTORY_LOGGING` | boolean | No | Set to `1` to disable trajectory persistence |

Disable via environment variable:

```bash
export ELIZA_DISABLE_TRAJECTORY_LOGGING=1
```

Trajectory logging is also automatically disabled when `NODE_ENV=test`.

## Related

- [Agent Skills Plugin](/plugin-registry/agent-skills) — Skill execution that generates trajectories
- [Agent Orchestrator Plugin](/plugin-registry/agent-orchestrator) — Task-agent orchestration
