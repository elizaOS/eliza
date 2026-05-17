---
title: "Sandbox Guide"
sidebarTitle: "Sandbox"
description: "How elizaOS routes local tool execution through sandboxed agent capabilities."
---

# Sandbox Guide

The sandbox is the local execution boundary for tools that need shell,
browser, file-system, or computer-control access. Runtime integrations should
enter through the app-core sandbox registry and the approved plugin surfaces
instead of opening direct host access from arbitrary UI or agent code.

Use these plugin boundaries for sandbox-capable features:

- `@elizaos/plugin-shell` owns shell command execution.
- `@elizaos/plugin-coding-tools` owns coding and repository automation tools.
- `agent-orchestrator` owns agent sandbox lifecycle coordination.

Mobile cloud builds must not include local sandbox backends. Store-gated
targets should keep sandbox capabilities behind the system build path and use
cloud-safe transports for normal Android and iOS app distribution.
