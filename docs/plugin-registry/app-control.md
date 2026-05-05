---
title: "App Control Plugin"
sidebarTitle: "App Control"
description: "Launch, close, and list running Eliza apps from agent chat."
---

The App Control plugin lets Eliza agents manage apps through conversation.

## Overview

This plugin exposes app lifecycle management to agents, backed by the `/api/apps` endpoints. Agents can launch installed apps, close running ones, and list what is currently active — all through natural language commands instead of the dashboard UI.

Key capabilities:

- **Launch apps** — start an installed Eliza app by name.
- **Close apps** — stop a running app.
- **List running apps** — see which apps are currently active.
- **Chat-driven control** — manage the app lifecycle without leaving the conversation.

## Configuration

No environment variables or configuration parameters are required. The plugin communicates with the Eliza API server directly.

## Usage Examples

> "Launch the dashboard app."

> "What apps are currently running?"

> "Close the monitoring app."

## Related

- [Eliza Cloud Plugin](/plugin-registry/elizacloud) — Cloud-hosted app deployment
- [Commands Plugin](/plugin-registry/commands) — Custom agent command definitions
