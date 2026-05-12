---
title: "Shopify Plugin"
sidebarTitle: "Shopify"
description: "Shopify Admin API integration -- manage products, orders, inventory, and customers"
---

Shopify Admin API integration for managing store operations.

**Package:** `@elizaos/plugin-shopify`

## Overview

The Shopify plugin connects Eliza agents to the Shopify Admin API, enabling management of products, orders, inventory, and customers directly through agent conversations.

## Installation

```bash
eliza plugins install shopify
```

## Auto-Enable

This plugin auto-enables when the `SHOPIFY_ACCESS_TOKEN` environment variable is set.

## Configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `SHOPIFY_ACCESS_TOKEN` | string | Yes (sensitive) | Shopify Admin API access token |
| `SHOPIFY_STORE_DOMAIN` | string | Yes | Store domain (e.g. `your-store.myshopify.com`) |
