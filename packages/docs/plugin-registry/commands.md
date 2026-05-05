---
title: "Commands Plugin"
sidebarTitle: "Commands"
description: "Chat command system for Eliza — /help, /status, /reset, and other slash commands for Eliza agents."
---

The Commands plugin provides a slash-command system for Eliza agents, enabling users to interact with agents through structured commands like `/help`, `/status`, and `/reset`.

**Package:** `@elizaos/plugin-commands` (core plugin — always loaded)

## Overview

This plugin registers a set of built-in chat commands that users can invoke directly in any conversation with an agent. Commands provide quick access to agent status, help information, conversation resets, and other utility functions without requiring natural-language interpretation. The plugin is always loaded as part of the core plugin set.

## Installation

This plugin is a core plugin and is always loaded. No manual installation is required.

## Related

- [Agent Orchestrator Plugin](/plugin-registry/agent-orchestrator) — Task-agent orchestration
- [Shell Plugin](/plugin-registry/shell) — Direct shell access for agents
