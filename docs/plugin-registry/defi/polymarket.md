---
title: "Polymarket Plugin"
sidebarTitle: "Polymarket"
description: "Multi-language Polymarket prediction markets plugin for elizaOS"
---

Prediction markets integration for Polymarket.

**Package:** `@elizaos/plugin-polymarket`

## Overview

The Polymarket plugin connects Milady agents to Polymarket prediction markets. Agents can browse markets, place bets, and manage positions. The plugin supports multiple languages for market interaction.

## Installation

```bash
milady plugins install polymarket
```

## Auto-Enable

This plugin auto-enables when the `POLYMARKET_API_KEY` environment variable is set.

## Configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `POLYMARKET_API_KEY` | string | Yes (sensitive) | Polymarket API key |
| `POLYMARKET_PRIVATE_KEY` | string | Yes (sensitive) | Polymarket private key |
