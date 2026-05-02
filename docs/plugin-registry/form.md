---
title: "Form Plugin"
sidebarTitle: "Form"
description: "Form chain integration for Eliza — curves-based token economics with ERC20 compatibility."
---

The Form plugin integrates Form chain capabilities into Eliza, enabling agents to interact with curves-based token economics and ERC20-compatible assets on the Form network.

**Package:** `@elizaos/plugin-form` (core plugin — always loaded)

## Overview

This plugin connects agents to the Form chain, providing access to curves-based token economics with full ERC20 compatibility. Agents can interact with Form chain smart contracts, manage token operations, and participate in the Form ecosystem. The plugin requires a private key for signing transactions.

## Installation

This plugin is a core plugin and is always loaded. No manual installation is required.

## Auto-Enable

The plugin auto-enables when the `FORM_PRIVATE_KEY` environment variable is set.

## Configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `FORM_PRIVATE_KEY` | string | **Yes** | Private key for Form chain (sensitive) |
| `FORM_RPC_URL` | string | No | Custom RPC URL for the Form network |

Set via environment variables:

```bash
export FORM_PRIVATE_KEY="your-private-key-here"
export FORM_RPC_URL="https://custom-rpc.example.com"
```

Or in `eliza.json`:

```json
{
  "settings": {
    "secrets": {
      "FORM_PRIVATE_KEY": "<FORM_PRIVATE_KEY>"
    },
    "FORM_RPC_URL": "https://custom-rpc.example.com"
  }
}
```

## Security

The `FORM_PRIVATE_KEY` is a sensitive value. Store it via environment variables or the Secrets Manager rather than committing it to configuration files.

## Related

- [Secrets (runtime)](/runtime/services#secrets-secrets-service) — Secure secret storage
