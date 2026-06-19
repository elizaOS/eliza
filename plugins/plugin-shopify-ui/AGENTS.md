# @elizaos/plugin-shopify-ui

Shopify store management dashboard — REST routes and React views for orders, products, inventory, and customers.

## Purpose / role

Adds a full Shopify store dashboard to an Eliza agent. The plugin registers seven HTTP routes under `/api/shopify/*` that proxy to the Shopify Admin GraphQL API (2025-04), and three elizaOS views (standard, XR, TUI) that render the dashboard UI. It is opt-in: import `shopifyPlugin` and add it to the runtime plugin list, or import the side-effect module `src/register-routes.ts` (which calls `registerAppRoutePluginLoader` to register a lazy loader).

## Plugin surface

### Routes (all `rawPath: true` — no plugin-name prefix)

| Method | Path | What it does |
|--------|------|-------------|
| GET | `/api/shopify/status` | Connection check; returns shop name/domain/plan or `{connected: false}` |
| GET | `/api/shopify/products` | Paginated product list (`?page`, `?limit`, `?q`) |
| POST | `/api/shopify/products` | Create a DRAFT product (`{title, vendor?, productType?, price?}`) |
| GET | `/api/shopify/orders` | Recent orders (`?status`, `?limit`); status: `any|paid|pending|refunded|partially_refunded` |
| GET | `/api/shopify/inventory` | Flat inventory level list across all locations (max 50 products × 10 variants × 10 locations) |
| POST | `/api/shopify/inventory/:itemId/adjust` | Adjust available quantity (`{delta, locationId?}`) |
| GET | `/api/shopify/customers` | Customer list (`?q`, `?limit`) |

### Views

| id | label | viewType | componentExport |
|----|-------|----------|----------------|
| `shopify` | Shopify | (default) | `ShopifyAppView` |
| `shopify` | Shopify XR | `xr` | `ShopifyAppView` |
| `shopify` | Shopify TUI | `tui` | `ShopifyTuiView` |

All views are bundled at `dist/views/bundle.js`.

### Overlay app

`shopifyApp` self-registers with `registerOverlayApp` (from `@elizaos/ui`) at import time via `src/register.ts`. The overlay app name is `@elizaos/plugin-shopify-ui`.

## Layout

```
src/
  index.ts               Public barrel: re-exports panels, views, routes, shopifyPlugin, shopifyApp, the hook
  plugin.ts              Plugin object: routes array + views array. Start here.
  routes.ts              handleShopifyRoute — all seven HTTP handlers; GraphQL helper shopifyGql
  shopify-app.ts         OverlayApp registration (shopifyApp, SHOPIFY_APP_NAME)
  register.ts            Side-effect import: calls registerOverlayApp at import time
  register-routes.ts     registerAppRoutePluginLoader call — dynamic lazy loader entry
  ShopifyAppView.tsx     Main React dashboard (tabs: overview/products/orders/inventory/customers)
                         Also exports ShopifyTuiView and the interact() capability dispatcher
  useShopifyDashboard.ts Data hook: polls all five endpoints every 30 s; typed state per panel
  ProductsPanel.tsx      Products tab panel component
  OrdersPanel.tsx        Orders tab panel component
  InventoryLevelsPanel.tsx Inventory tab panel component
  CustomersPanel.tsx     Customers tab panel component
  StoreOverviewCard.tsx  Overview tab summary card (shop name, counts)
  ShopifyTuiView.test.tsx  Co-located component test for the TUI view
assets/
  hero.png               elizaos.app manifest hero image
test/
  shopify-api.real.e2e.test.ts  Live-API end-to-end test (run with test:e2e:manual)
```

## Commands

```bash
bun run --cwd plugins/plugin-shopify-ui build           # tsup + vite views + tsc types
bun run --cwd plugins/plugin-shopify-ui build:js        # tsup only (compiles every src/ file, no bundling)
bun run --cwd plugins/plugin-shopify-ui build:views     # vite bundle (entry src/ShopifyAppView.tsx, also exports ShopifyTuiView)
bun run --cwd plugins/plugin-shopify-ui build:types     # tsc declaration emit
bun run --cwd plugins/plugin-shopify-ui clean           # rm -rf dist
bun run --cwd plugins/plugin-shopify-ui test            # vitest unit + component tests
bun run --cwd plugins/plugin-shopify-ui test:e2e:manual # live-API e2e (needs real creds)
```

## Config / env vars

| Var | Required | Description |
|-----|----------|-------------|
| `SHOPIFY_STORE_DOMAIN` | Yes (for live data) | e.g. `mystore.myshopify.com` or the full `https://` URL |
| `SHOPIFY_ACCESS_TOKEN` | Yes (for live data) | Shopify Admin API access token |

When either var is absent, `GET /api/shopify/status` returns `{connected: false}` and all other routes return 404. The API version is pinned to `2025-04` in `src/routes.ts`.

Required Shopify API scopes: `read_products`, `write_products`, `read_orders`, `read_inventory`, `write_inventory`, `read_customers`.

## How to extend

**Add a route:**
1. Add the handler logic to `src/routes.ts` inside `handleShopifyRoute` (follow the existing `if (method === '...' && pathname === '...')` pattern).
2. Add the corresponding `Route` entry to the `shopifyRoutes` array in `src/plugin.ts`. Set `rawPath: true`.
3. Export any new types from `src/useShopifyDashboard.ts` if the route returns new data shapes.

**Add a React panel:**
1. Create `src/MyPanel.tsx`. Export the component.
2. Import it in `src/ShopifyAppView.tsx` and add a `TabsContent` entry.
3. Add the tab descriptor to `DASHBOARD_TABS`.
4. Export the component from `src/index.ts`.

**Add a TUI capability:**
1. Implement a new `if (capability === 'terminal-shopify-<name>')` branch in the `interact()` function in `src/ShopifyAppView.tsx`.
2. Document the new capability name and its params in this file.

## Conventions / gotchas

- **Dual build:** The plugin has two independent outputs. `tsup` compiles all `src/` files (all routes, views, and helpers — server-compatible ESM, no bundling). `vite build:views` bundles `ShopifyAppView.tsx` and `ShopifyTuiView` into `dist/views/bundle.js` for in-browser delivery. Server-side changes go through tsup; browser bundle changes go through vite.
- **GraphQL API version is pinned:** `API_VERSION = "2025-04"` in `src/routes.ts`. When upgrading, update this constant and verify all field paths against the new schema.
- **Inventory pagination cap:** The inventory endpoint fetches at most 50 products × 10 variants × 10 locations in a single GraphQL query. There is no cursor pagination for inventory. Large catalogs will be truncated.
- **Product page cursor:** The products endpoint simulates page-N by re-fetching cursor chains from page 1. Deep pagination is expensive. Prefer search (`?q=`) to reduce result sets.
- **`rawPath: true`:** All routes bypass the runtime's plugin-name prefix. The paths are `/api/shopify/*` exactly — not `/api/plugin-shopify-ui/shopify/*`.
- **`registerOverlayApp` side-effect:** Importing `src/register.ts` (or `src/shopify-app.ts`) immediately calls `registerOverlayApp`. In server-only (non-browser) builds, guard against importing these modules.
- **No actions, providers, services, or evaluators:** This plugin is routes + views only. It has no agent-facing natural language actions.
- See `../../AGENTS.md` (repo root) for global conventions: logger-only logging, ESM module rules, naming, architecture commandments.
