---
title: "Minecraft Plugin"
sidebarTitle: "Minecraft"
description: "Minecraft automation app for driving Mineflayer bots from Eliza agents"
---

Minecraft bot automation powered by Mineflayer.

**Package:** `@elizaos/plugin-minecraft`

## Overview

The Minecraft plugin lets Eliza agents drive Mineflayer bots inside Minecraft servers. Agents can join servers, navigate the world, interact with blocks and entities, and carry out automated gameplay tasks.

## Installation

```bash
eliza plugins install minecraft
```

## Auto-Enable

This plugin auto-enables when the `MINECRAFT_HOST` environment variable is set.

## Configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `MINECRAFT_HOST` | string | Yes | Minecraft server host |
| `MINECRAFT_PORT` | string | No | Server port (default: `25565`) |
| `MINECRAFT_USERNAME` | string | Yes | Bot username |
| `MINECRAFT_VERSION` | string | No | Minecraft version to connect with |
