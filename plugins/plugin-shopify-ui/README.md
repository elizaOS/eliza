# @elizaos/plugin-shopify-ui

Shopify store management for elizaOS agents. Adds REST API routes and a React dashboard UI covering orders, products, inventory, and customers.

## What it does

- Registers seven HTTP routes under `/api/shopify/*` that proxy to the Shopify Admin GraphQL API.
- Provides a tabbed React dashboard (standard + XR view) and a terminal-compatible TUI view.
- Displays store overview, recent orders, low-inventory alerts, product catalog, customer list, and per-location inventory levels.
- Supports creating new draft products and adjusting inventory quantities directly from the UI.

## Capabilities / routes

| Endpoint | Description |
|----------|-------------|
| `GET /api/shopify/status` | Check connection; returns shop name, domain, plan, currency |
| `GET /api/shopify/products` | List products with pagination and search |
| `POST /api/shopify/products` | Create a draft product |
| `GET /api/shopify/orders` | List orders filtered by financial status |
| `GET /api/shopify/inventory` | List inventory levels across all locations |
| `POST /api/shopify/inventory/:itemId/adjust` | Adjust available quantity for an inventory item |
| `GET /api/shopify/customers` | List customers with search |

## Required environment variables

| Variable | Description |
|----------|-------------|
| `SHOPIFY_STORE_DOMAIN` | Your store domain, e.g. `mystore.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | Shopify Admin API access token |

Without these, the status endpoint returns `{connected: false}` and all data routes return 404.

## Required Shopify API scopes

`read_products`, `write_products`, `read_orders`, `read_inventory`, `write_inventory`, `read_customers`

## How to enable

Add the plugin to your elizaOS agent configuration:

```ts
import { shopifyPlugin } from "@elizaos/plugin-shopify-ui/plugin";

// Pass to your agent runtime plugin list
const agent = new AgentRuntime({
  plugins: [shopifyPlugin],
  // ...
});
```

The dashboard view appears at path `/shopify` in the elizaOS UI. The TUI view is available at `/shopify/tui` for terminal-based agent surfaces.

## Notes

- The inventory endpoint fetches up to 50 products × 10 variants × 10 locations per query. Large catalogs are truncated at these limits.
- The Shopify GraphQL API version is `2025-04`.
- Product pagination uses cursor-chain traversal; prefer the search parameter (`?q=`) for large catalogs to avoid deep page walks.
