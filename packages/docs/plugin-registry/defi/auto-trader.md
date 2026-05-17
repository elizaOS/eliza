---
title: "Auto Trader Plugin"
sidebarTitle: "Auto Trader"
description: "Autonomous trading plugin with LLM-powered strategies for Solana"
---

Autonomous trading plugin that uses LLM-powered strategies to execute trades on Solana.

**Package:** `@elizaos/plugin-auto-trader`

## Overview

The Auto Trader plugin enables Eliza agents to autonomously trade tokens on Solana using configurable, LLM-driven strategies. It supports position sizing limits and multiple risk levels to match different trading profiles.

## Installation

```bash
eliza plugins install auto-trader
```

## Auto-Enable

This plugin auto-enables when the `SOLANA_PRIVATE_KEY` environment variable is set.

## Configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `SOLANA_PRIVATE_KEY` | string | Yes (sensitive) | Solana wallet private key |
| `SOLANA_RPC_URL` | string | No | Solana RPC endpoint |
| `AUTO_TRADER_MAX_POSITION_SIZE` | string | No | Maximum position size in SOL |
| `AUTO_TRADER_RISK_LEVEL` | string | No | Risk level: `conservative`, `moderate`, or `aggressive` |
