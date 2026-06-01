# @elizaos/plugin-shopify

Shopify Admin API plugin for elizaOS. Gives an Eliza agent the ability to manage products, orders, inventory, and customers on a Shopify store through conversational commands.

## What it does

When this plugin is active, an Eliza agent can:

- **Search** — read-only cross-entity search across products, orders, and customers.
- **Manage products** — list products (with optional query), create new products (DRAFT or ACTIVE), update title / description / status.
- **Manage inventory** — check stock levels per location, adjust inventory quantities, list store locations.
- **Manage orders** — list orders (with optional filter), get a single order by number, fulfill open orders.
- **Manage customers** — list or search customers, view customer detail.

Write operations (create product, update product, adjust inventory, fulfill order) ask the user for explicit confirmation before executing.

## Installation

Add the plugin to your agent's character file:

```json
{
  "plugins": ["@elizaos/plugin-shopify"]
}
```

The plugin self-enables when `SHOPIFY_ACCESS_TOKEN` is set in the agent's environment. No explicit opt-in is required when that variable is present.

## Configuration

### Minimum required

| Variable | Description |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | Your store domain, e.g. `mystore.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | Shopify Admin API access token from a private or custom app |

### Shopify API scopes needed

Your access token must have at minimum:

```
read_products, write_products, read_orders, write_orders,
read_customers, read_inventory, write_inventory, read_locations
```

### Multi-store support

To connect more than one store, set `SHOPIFY_ACCOUNTS` to a JSON array of account records:

```json
[
  { "accountId": "store-a", "storeDomain": "store-a.myshopify.com", "accessToken": "shpat_..." },
  { "accountId": "store-b", "storeDomain": "store-b.myshopify.com", "accessToken": "shpat_..." }
]
```

Set `SHOPIFY_DEFAULT_ACCOUNT_ID` to the `accountId` that should be used when none is specified in a request. Accounts can also be declared under `character.settings.shopify.accounts` in the character file.

### OAuth flow (optional)

If you want users to connect stores through an OAuth flow rather than a static access token, set:

| Variable | Description |
|---|---|
| `SHOPIFY_OAUTH_CLIENT_ID` | Client ID from your Shopify app |
| `SHOPIFY_OAUTH_CLIENT_SECRET` | Client secret from your Shopify app |
| `SHOPIFY_OAUTH_REDIRECT_URI` | Redirect URI registered in your Shopify app settings |

## Usage examples

```
Show me my Shopify orders from this week
Search my store for "blue hat"
List all active products
Create a new product: red t-shirt, $25, vendor Acme
Adjust inventory for blue hat by -3 units
Fulfill order #1042
Find customer jane@example.com
```

The agent infers the operation from natural language. You can also be explicit:

```
Shopify action=products action=list
Shopify action=inventory action=check productQuery="blue hat"
```

## Context requirements

The `SHOPIFY` action is available in agent contexts: `payments`, `connectors`, `automation`, `knowledge`. The store context provider activates in `connectors` and `finance` contexts. Ensure your agent character has at least one of these contexts enabled.
