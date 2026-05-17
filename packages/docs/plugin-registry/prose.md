---
title: "Prose Plugin"
sidebarTitle: "Prose"
description: "OpenProse VM integration for Eliza — a programming language for AI sessions."
---

The Prose plugin integrates the OpenProse VM with Eliza, providing a programming language designed specifically for AI sessions.

**Package:** `@elizaos/plugin-prose`

## Overview

OpenProse is a programming language built for orchestrating AI interactions. This plugin brings OpenProse VM capabilities into the elizaOS runtime, allowing agents to execute structured session programs that coordinate prompts, tool calls, and multi-step workflows.

Rather than describing agent behavior in natural language alone, OpenProse programs provide deterministic control flow for AI sessions while still allowing the model to generate responses at each step.

## Installation

```bash
eliza plugins install prose
```

## Configuration

No environment variables or configuration required. The plugin works out of the box once installed.

## Usage

Once installed, agents can interpret and execute OpenProse programs passed as input. The VM handles control flow, variable binding, and tool dispatch within the session context.

> "Run this Prose program to summarize the last five messages and generate a follow-up question."

The plugin registers with the elizaOS runtime and is available to any agent that has it enabled.
