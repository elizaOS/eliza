---
title: "Directives Plugin"
sidebarTitle: "Directives"
description: "Inline directive parsing for Eliza agents (@think, @model, @verbose, etc.)"
---

Inline directive parsing that lets users control agent behavior mid-conversation.

**Package:** `@elizaos/plugin-directives`

## Overview

The Directives plugin adds inline directive parsing to elizaOS agents. Users can include directives such as `@think`, `@model`, `@verbose`, and others directly in their messages to modify how the agent processes and responds to that particular input. This provides fine-grained, per-message control over agent behavior without changing global configuration.

## Installation

```bash
eliza plugins install directives
```

## Configuration

This plugin has no configuration parameters. It works out of the box once installed.

## Related

- [Personality and behavior](/agents/personality-and-behavior) — Character fields, system prompt, and evolution
- [CLI Plugin](/plugin-registry/cli-plugin) - Command registration and interactive terminal sessions
