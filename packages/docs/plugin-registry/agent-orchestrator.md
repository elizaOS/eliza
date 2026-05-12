---
title: "Agent Orchestrator Plugin"
sidebarTitle: "Agent Orchestrator"
description: "Task-agent orchestration plugin for Eliza — spawn and manage open-ended CLI task agents via PTY."
---

The Agent Orchestrator plugin enables Eliza to spawn and manage open-ended CLI task agents through PTY sessions, allowing agents to delegate complex tasks to specialized child agents.

**Package:** `@elizaos/core` (core plugin — always loaded)

## Overview

The Agent Orchestrator provides the backbone for multi-agent task delegation within Eliza. It manages the lifecycle of spawned task agents, routing work to dedicated CLI processes via PTY and collecting their results. This enables an agent to break down complex, open-ended tasks and dispatch them to purpose-built sub-agents that run in parallel or in sequence.

## Installation

This plugin is bundled in `@elizaos/core` and is always loaded automatically. No installation step is required.

## Related

- [Agent Skills Plugin](/plugin-registry/agent-skills) — Skill execution for agents
- [Shell Plugin](/plugin-registry/shell) — Direct shell access for agents
- [Plugin Manager Plugin](/plugin-registry/plugin-manager) — Dynamic plugin loading at runtime
