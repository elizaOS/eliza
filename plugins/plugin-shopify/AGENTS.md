# @elizaos/plugin-shopify

Shopify Admin API plugin for elizaOS agents — manage products, orders, inventory, and customers.

## Purpose / role

Gives an Eliza agent the ability to read and write a Shopify store via the Admin GraphQL API (version 2025-04). The plugin is opt-in; it self-enables when `SHOPIFY_ACCESS_TOKEN` or `SHOPIFY_ACCOUNTS` is set in the agent's environment. It registers one composite action (`SHOPIFY`), one provider (`shopifyStoreContext`), and one service (`ShopifyService`).

## Plugin surface

### Action

**`SHOPIFY`** — single top-level action that routes internally by operation type.

| Op | Trigger keywords | What it does |
|---|---|---|
| `search` | search, find, browse, catalog | Read-only fan-out across products, orders, and customers |
| `products` | product, sku, variant, listing, item | List / create / update products |
| `inventory` | inventory, stock, quantity, restock | Check levels, adjust delta, list locations |
| `orders` | order, fulfill, ship, refund, return | List, get, or fulfill orders |
| `customers` | customer, buyer, shopper, client | List or search customers |

Legacy similes (older callers still resolve): `MANAGE_SHOPIFY_PRODUCTS`, `MANAGE_SHOPIFY_INVENTORY`, `MANAGE_SHOPIFY_ORDERS`, `MANAGE_SHOPIFY_CUSTOMERS`, `LIST_PRODUCTS`, `CREATE_PRODUCT`, `UPDATE_PRODUCT`, `SEARCH_PRODUCTS`, `CHECK_INVENTORY`, `ADJUST_INVENTORY`, `CHECK_STOCK`, `UPDATE_STOCK`, `LIST_ORDERS`, `CHECK_ORDERS`, `FULFILL_ORDER`, `ORDER_STATUS`, `LIST_CUSTOMERS`, `FIND_CUSTOMER`, `SEARCH_CUSTOMERS`.

Write operations (create product, update product, adjust inventory, fulfill order) gate through `gateDestructiveConfirmation` — the agent will ask the user to confirm before executing.

### Provider

**`shopifyStoreContext`** — injects connected store name, domain, plan, currency, product count, and order count into the agent's context. Dynamic, turn-scoped, gated to `connectors` / `finance` contexts.

### Service

**`ShopifyService`** (`serviceType = "shopify"`) — holds one `ShopifyClient` per configured account. Exposes: `getShop`, `listProducts`, `createProduct`, `updateProduct`, `listOrders`, `getOrder`, `fulfillOrder`, `listCustomers`, `checkInventory`, `adjustInventory`, `listLocations`, `getProductCount`, `getOrderCount`, `isConnected`.

### ConnectorAccountManager integration

`createShopifyConnectorAccountProvider` is registered in `plugin.init`. Supports list, create, patch, delete, and full Shopify OAuth flow (`startOAuth` / `completeOAuth`). OAuth requires three extra env vars (see Config below).

## Layout

```
src/
  index.ts                          Plugin entry; registers action, provider, service; wires ConnectorAccountManager
  types.ts                          All Shopify GraphQL response types (Product, Order, Customer, InventoryLevel, ...)
  accounts.ts                       Account config resolution (env vars + character.settings.shopify.accounts)
  shopify-client.ts                 Lightweight fetch-based GraphQL client (no external deps)
  connector-account-provider.ts     ConnectorAccountManager provider (list/create/patch/delete/OAuth)
  shopify.ts                        SHOPIFY action; regex + explicit routing to sub-handlers
  manage-products.ts                products op — list / create / update, with LLM intent classification
  manage-orders.ts                  orders op — list / get / fulfill, with LLM intent classification
  manage-customers.ts               customers op — list / search, with LLM intent classification
  manage-inventory.ts               inventory op — check / adjust / locations, with LLM intent classification
  search-store.ts                   search op — fan-out read across products + orders + customers
  confirmation.ts                   requireShopifyConfirmation helper (wraps gateDestructiveConfirmation)
  account-options.ts                getShopifyAccountId / hasShopifyConfig helpers; shopifyAccountIdParameter
  json.ts                           parseJsonObject utility used by LLM intent classifiers
  services/ShopifyService.ts        Service class; one ShopifyClient per account; all Admin API calls
  providers/store-context.ts        shopifyStoreContext provider implementation
  accounts.test.ts                  Unit tests for account config resolution
```

## Commands

```bash
bun run --cwd plugins/plugin-shopify build       # tsup build to dist/
bun run --cwd plugins/plugin-shopify dev         # tsup watch
bun run --cwd plugins/plugin-shopify test        # vitest unit tests
bun run --cwd plugins/plugin-shopify test:e2e    # live smoke test (requires running agent)
```

## Config / env vars

### Required for basic operation

| Variable | Description |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | Store domain, e.g. `mystore.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | Shopify Admin API access token (private app or custom app) |

### Optional / multi-account

| Variable | Description |
|---|---|
| `SHOPIFY_ACCOUNT_ID` / `SHOPIFY_DEFAULT_ACCOUNT_ID` | Which account id to use as default (defaults to `"default"`) |
| `SHOPIFY_ACCOUNTS` | JSON array or object of account records for multi-store setups. Each record needs `storeDomain` and `accessToken`. |

Accounts can also be declared in `character.settings.shopify.accounts` (array or object keyed by id). Env vars take precedence within the same account id.

### OAuth (optional, only needed for the ConnectorAccountManager OAuth flow)

| Variable | Description |
|---|---|
| `SHOPIFY_OAUTH_CLIENT_ID` | Shopify app client id |
| `SHOPIFY_OAUTH_CLIENT_SECRET` | Shopify app client secret |
| `SHOPIFY_OAUTH_REDIRECT_URI` | OAuth redirect URI registered with the Shopify app |

### Required Shopify API scopes

`read_products`, `write_products`, `read_orders`, `write_orders`, `read_customers`, `read_inventory`, `write_inventory`, `read_locations`.

## How to extend

**Add a new operation to the SHOPIFY action:**

1. Create `src/manage-<thing>.ts` exporting an async handler matching the `ShopifyHandler` signature in `src/shopify.ts`.
2. Add the operation name to `ALL_OPS` in `src/shopify.ts` and add a `ShopifyRoute` entry to `ROUTES` with a match regex and the new handler.
3. Add any required Admin API calls to `ShopifyService` in `src/services/ShopifyService.ts`. Add response types to `src/types.ts`.

**Add a new provider:**

1. Create `src/providers/<name>.ts` exporting a `Provider` object.
2. Import it in `src/index.ts` and add it to `shopifyPlugin.providers`.

**Add a new service:**

1. Create `src/services/<Name>Service.ts` extending `Service` from `@elizaos/core`.
2. Import and add it to `shopifyPlugin.services` in `src/index.ts`.

## Conventions / gotchas

- **LLM intent classification**: each operation handler uses `ModelType.TEXT_SMALL` to classify free-text intent when structured parameters are absent. Keep prompts minimal and deterministic.
- **Confirmation gate**: all write operations call `requireShopifyConfirmation` (which delegates to `gateDestructiveConfirmation`). Never skip this for mutations.
- **Inventory item IDs**: Shopify variant GIDs (`gid://shopify/ProductVariant/<n>`) share the numeric suffix with inventory item GIDs (`gid://shopify/InventoryItem/<n>`). The handlers derive one from the other by swapping the type segment — do not query a separate endpoint.
- **Variant fetching cap**: `listProducts` returns first 5 variants per product. If a product has more than 5 variants, deep inventory operations may need a dedicated variant query.
- **No external runtime deps**: `ShopifyClient` uses native `fetch` only. Do not add Shopify SDK packages.
- **Multi-account routing**: pass `accountId` in action options to target a specific store. Omitting it uses the default account (env `SHOPIFY_DEFAULT_ACCOUNT_ID` or fallback to first loaded account).
- **API version**: pinned to `2025-04` in `src/shopify-client.ts`. Update there when upgrading.
- **Context gates**: the `SHOPIFY` action is gated to `anyOf: ["payments", "connectors", "automation", "knowledge"]`; the `shopifyStoreContext` provider to `anyOf: ["connectors", "finance"]`. Agents must have these contexts enabled for the plugin to be active.
