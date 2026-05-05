---
title: "Plugin Manager Plugin"
sidebarTitle: "Plugin Manager"
description: "Dynamic plugin management for Eliza — load and unload plugins at runtime without restarting the agent."
---

The Plugin Manager enables dynamic loading and unloading of plugins at runtime, allowing agents to extend their capabilities on the fly without a restart.

**Implementation:** Built into `@elizaos/core` (plugin-manager feature; enabled via `enablePluginManager`, on by default in typical Eliza configs).

## Overview

This plugin provides the runtime infrastructure for managing the agent's plugin lifecycle. It supports installing, loading, and unloading plugins while the agent is running, making it possible to add new capabilities or remove unused ones dynamically. This is the mechanism behind the `eliza plugins install` CLI command and the admin panel's plugin management UI.

## Installation

This plugin is a core plugin and is always loaded. No manual installation is required.

## Related

- [Agent Skills Plugin](/plugin-registry/agent-skills) — Skill discovery and execution
- [Agent Orchestrator Plugin](/plugin-registry/agent-orchestrator) — Task-agent orchestration
