---
title: "Roblox Plugin"
sidebarTitle: "Roblox"
description: "Roblox app integration for agent-driven gameplay and interactive experiences"
---

Roblox integration for agent-driven gameplay.

**Package:** `@elizaos/plugin-roblox`

## Overview

The Roblox plugin connects Eliza agents to Roblox, enabling agent-driven gameplay and interactive experiences within the platform.

## Installation

```bash
eliza plugins install roblox
```

## Auto-Enable

This plugin auto-enables when the `ROBLOX_COOKIE` environment variable is set.

## Configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ROBLOX_COOKIE` | string | Yes (sensitive) | Roblox authentication cookie |
