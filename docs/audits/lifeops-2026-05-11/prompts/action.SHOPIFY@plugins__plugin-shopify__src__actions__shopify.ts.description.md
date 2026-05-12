# `action.SHOPIFY@plugins/plugin-shopify/src/actions/shopify.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-shopify
- **File**: `plugins/plugin-shopify/src/actions/shopify.ts:110`
- **Token count**: 75
- **Last optimized**: never
- **Action**: SHOPIFY
- **Similes**: MANAGE_SHOPIFY_PRODUCTS, MANAGE_SHOPIFY_INVENTORY, MANAGE_SHOPIFY_ORDERS, MANAGE_SHOPIFY_CUSTOMERS, LIST_PRODUCTS, CREATE_PRODUCT, UPDATE_PRODUCT, SEARCH_PRODUCTS, CHECK_INVENTORY, ADJUST_INVENTORY, CHECK_STOCK, UPDATE_STOCK, LIST_ORDERS, CHECK_ORDERS, FULFILL_ORDER, ORDER_STATUS, LIST_CUSTOMERS, FIND_CUSTOMER, SEARCH_CUSTOMERS

## Current text
```
Manage a Shopify store. Actions: search (read-only catalog browsing across products, orders, and customers), products (CRUD on products), inventory (stock adjustments), orders (list/update orders), customers (CRUD on customers). Action is inferred from the message text when not explicitly provided.
```

## Compressed variant
```
Shopify: search, products, inventory, orders, customers.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (56 chars vs 299 chars — 81% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
