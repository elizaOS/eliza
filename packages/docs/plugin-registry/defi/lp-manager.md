---
title: "LP Manager Plugin"
sidebarTitle: "LP Manager"
description: "A unified plugin for managing liquidity positions on Solana DEXs (Raydium, Orca, etc.)"
---

Unified liquidity position management across Solana DEXs.

**Package:** `@elizaos/plugin-lp-manager`

## Overview

The LP Manager plugin lets Eliza agents manage liquidity positions on Solana decentralized exchanges such as Raydium and Orca. It provides a single interface for creating, monitoring, and adjusting LP positions across supported protocols.

## Installation

```bash
eliza plugins install lp-manager
```

## Auto-Enable

This plugin auto-enables when the `SOLANA_PRIVATE_KEY` environment variable is set.

## Configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `SOLANA_PRIVATE_KEY` | string | Yes (sensitive) | Solana wallet private key |
| `SOLANA_RPC_URL` | string | No | Solana RPC endpoint |
