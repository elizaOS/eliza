---
title: "Hedera Plugin"
sidebarTitle: "Hedera"
description: "ElizaOS plugin for Hedera blockchain"
---

Hedera blockchain integration for **elizaOS** agents.

**Package:** `@elizaos/plugin-hedera`

## Overview

The Hedera plugin enables Eliza agents to interact with the Hedera network. Agents can perform on-chain operations using their configured Hedera account across mainnet, testnet, or previewnet environments.

## Installation

```bash
eliza plugins install hedera
```

## Auto-Enable

This plugin auto-enables when the `HEDERA_ACCOUNT_ID` environment variable is set.

## Configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `HEDERA_ACCOUNT_ID` | string | Yes | Hedera account ID |
| `HEDERA_PRIVATE_KEY` | string | Yes (sensitive) | Hedera account private key |
| `HEDERA_NETWORK` | string | No | Network selection: `mainnet`, `testnet`, or `previewnet` |
