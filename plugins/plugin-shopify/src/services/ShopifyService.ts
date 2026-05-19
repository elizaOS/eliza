import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  DEFAULT_SHOPIFY_ACCOUNT_ID,
  normalizeShopifyAccountId,
  readShopifyAccounts,
  resolveShopifyDefaultAccount,
  type ShopifyAccountConfig,
} from "../accounts.js";
import { ShopifyClient } from "../shopify-client.js";
import type {
  Customer,
  CustomerEdge,
  CustomersResponse,
  FulfillmentCreateResponse,
  FulfillmentOrdersResponse,
  InventoryAdjustResponse,
  InventoryItemResponse,
  InventoryLevel,
  Location,
  LocationEdge,
  LocationsResponse,
  Order,
  OrderCountResponse,
  OrderEdge,
  OrderResponse,
  OrdersResponse,
  Product,
  ProductCountResponse,
  ProductCreateResponse,
  ProductEdge,
  ProductsResponse,
  ProductUpdateResponse,
  ShopInfo,
  ShopInfoResponse,
  ShopifyUserError,
} from "../types.js";

export const SHOPIFY_SERVICE_TYPE = "shopify" as const;

interface ShopifyClientState {
  accountId: string;
  config: ShopifyAccountConfig;
  client: ShopifyClient;
}

// ---------------------------------------------------------------------------
// GraphQL fragments + queries
// ---------------------------------------------------------------------------

const PRODUCT_FIELDS = `
  id
  title
  handle
  status
  descriptionHtml
  productType
  vendor
  totalInventory
  featuredImage { url altText }
  variants(first: 5) {
    edges { node { id title price sku inventoryQuantity } }
  }
`;

const ORDER_FIELDS = `
  id
  name
  createdAt
  displayFinancialStatus
  displayFulfillmentStatus
  totalPriceSet { shopMoney { amount currencyCode } }
  customer { id displayName }
  lineItems(first: 10) {
    edges { node { title quantity originalUnitPriceSet { shopMoney { amount currencyCode } } } }
  }
`;

const CUSTOMER_FIELDS = `
  id
  displayName
  email
  phone
  ordersCount
  totalSpentV2 { amount currencyCode }
  createdAt
`;

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

function formatUserErrors(errors: ShopifyUserError[]): string {
  return errors
    .map((e) => `${e.field?.join(".") ?? "?"}: ${e.message}`)
    .join("; ");
}

export class ShopifyService extends Service {
  static serviceType = SHOPIFY_SERVICE_TYPE;
  capabilityDescription =
    "Connects the agent to a Shopify store for managing products, orders, inventory, and customers through the Admin GraphQL API.";

  private clients = new Map<string, ShopifyClientState>();
  private defaultAccountId = DEFAULT_SHOPIFY_ACCOUNT_ID;

  async stop(): Promise<void> {
    this.clients.clear();
  }

  static override async start(runtime: IAgentRuntime): Promise<ShopifyService> {
    const svc = new ShopifyService(runtime);
    const accounts = readShopifyAccounts(runtime);
    const requestedDefault = normalizeShopifyAccountId(
      runtime.getSetting("SHOPIFY_DEFAULT_ACCOUNT_ID") ??
        runtime.getSetting("SHOPIFY_ACCOUNT_ID"),
    );
    const defaultAccount = resolveShopifyDefaultAccount(
      accounts,
      requestedDefault,
    );

    if (!defaultAccount) {
      logger.warn(
        { src: "plugin:shopify", agentId: runtime.agentId },
        "No Shopify account configured -- Shopify service inactive",
      );
      return svc;
    }

    svc.defaultAccountId = defaultAccount.accountId;
    for (const account of accounts) {
      svc.clients.set(account.accountId, {
        accountId: account.accountId,
        config: account,
        client: new ShopifyClient(account.storeDomain, account.accessToken),
      });
    }

    // Verify connectivity
    try {
      const shop = await svc.getShop();
      logger.info(
        {
          src: "plugin:shopify",
          agentId: runtime.agentId,
          accountId: defaultAccount.accountId,
          store: shop.name,
        },
        `Shopify connected to "${shop.name}" (${shop.myshopifyDomain})`,
      );
    } catch (err) {
      logger.error(
        {
          src: "plugin:shopify",
          agentId: runtime.agentId,
          error: err instanceof Error ? err.message : String(err),
        },
        "Failed to connect to Shopify store",
      );
      svc.clients.delete(defaultAccount.accountId);
    }

    return svc;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  isConnected(accountId?: string): boolean {
    return Boolean(this.getClientState(accountId, false));
  }

  private getClientState(accountId?: string): ShopifyClientState;
  private getClientState(
    accountId: string | undefined,
    throwOnMissing: false,
  ): ShopifyClientState | null;
  private getClientState(
    accountId?: string,
    throwOnMissing = true,
  ): ShopifyClientState | null {
    const normalized = normalizeShopifyAccountId(accountId);
    const state = accountId
      ? (this.clients.get(normalized) ?? null)
      : (this.clients.get(this.defaultAccountId) ??
        Array.from(this.clients.values())[0] ??
        null);
    if (!state && throwOnMissing) {
      throw new Error(
        "Shopify client is not initialised. Check SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN.",
      );
    }
    return state;
  }

  private requireClient(accountId?: string): ShopifyClient {
    return this.getClientState(accountId)?.client as ShopifyClient;
  }

  // -----------------------------------------------------------------------
  // Shop
  // -----------------------------------------------------------------------

  async getShop(accountId?: string): Promise<ShopInfo> {
    const data = await this.requireClient(accountId).query<ShopInfoResponse>(`{
      shop {
        name
        email
        myshopifyDomain
        plan { displayName }
        currencyCode
        primaryDomain { url }
      }
    }`);
    return data.shop;
  }

  // -----------------------------------------------------------------------
  // Products
  // -----------------------------------------------------------------------

  async listProducts(
    opts: { first?: number; after?: string | null; query?: string | null } = {},
    accountId?: string,
  ): Promise<{
    products: Product[];
    hasNextPage: boolean;
    endCursor: string | null;
  }> {
    const first = Math.min(opts.first ?? 10, 50);
    const variables: Record<string, unknown> = { first };
    if (opts.after) variables.after = opts.after;
    if (opts.query) variables.query = opts.query;

    const gql = `query ListProducts($first: Int!, $after: String, $query: String) {
      products(first: $first, after: $after, query: $query, sortKey: TITLE) {
        edges { node { ${PRODUCT_FIELDS} } }
        pageInfo { hasNextPage endCursor }
      }
    }`;

    const data = await this.requireClient(accountId).query<ProductsResponse>(
      gql,
      variables,
    );
    return {
      products: data.products.edges.map((e: ProductEdge) => e.node),
      hasNextPage: data.products.pageInfo.hasNextPage,
      endCursor: data.products.pageInfo.endCursor,
    };
  }

  async createProduct(
    input: {
      title: string;
      descriptionHtml?: string;
      productType?: string;
      vendor?: string;
      status?: string;
    },
    accountId?: string,
  ): Promise<Product> {
    const gql = `mutation CreateProduct($input: ProductInput!) {
      productCreate(input: $input) {
        product { ${PRODUCT_FIELDS} }
        userErrors { field message }
      }
    }`;
    const data = await this.requireClient(
      accountId,
    ).query<ProductCreateResponse>(gql, {
      input: {
        title: input.title,
        descriptionHtml: input.descriptionHtml ?? "",
        productType: input.productType ?? "",
        vendor: input.vendor ?? "",
        status: (input.status ?? "DRAFT").toUpperCase(),
      },
    });
    if (data.productCreate.userErrors.length > 0) {
      throw new Error(
        `Product create failed: ${formatUserErrors(data.productCreate.userErrors)}`,
      );
    }
    if (!data.productCreate.product) {
      throw new Error("Product create returned no product");
    }
    return data.productCreate.product;
  }

  async updateProduct(
    id: string,
    input: {
      title?: string;
      descriptionHtml?: string;
      productType?: string;
      vendor?: string;
      status?: string;
    },
    accountId?: string,
  ): Promise<Product> {
    const gql = `mutation UpdateProduct($input: ProductInput!) {
      productUpdate(input: $input) {
        product { ${PRODUCT_FIELDS} }
        userErrors { field message }
      }
    }`;
    const data = await this.requireClient(
      accountId,
    ).query<ProductUpdateResponse>(gql, {
      input: { id, ...input },
    });
    if (data.productUpdate.userErrors.length > 0) {
      throw new Error(
        `Product update failed: ${formatUserErrors(data.productUpdate.userErrors)}`,
      );
    }
    if (!data.productUpdate.product) {
      throw new Error("Product update returned no product");
    }
    return data.productUpdate.product;
  }

  // -----------------------------------------------------------------------
  // Orders
  // -----------------------------------------------------------------------

  async listOrders(
    opts: { first?: number; after?: string | null; query?: string | null } = {},
    accountId?: string,
  ): Promise<{
    orders: Order[];
    hasNextPage: boolean;
    endCursor: string | null;
  }> {
    const first = Math.min(opts.first ?? 10, 50);
    const variables: Record<string, unknown> = { first };
    if (opts.after) variables.after = opts.after;
    if (opts.query) variables.query = opts.query;

    const gql = `query ListOrders($first: Int!, $after: String, $query: String) {
      orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges { node { ${ORDER_FIELDS} } }
        pageInfo { hasNextPage endCursor }
      }
    }`;

    const data = await this.requireClient(accountId).query<OrdersResponse>(
      gql,
      variables,
    );
    return {
      orders: data.orders.edges.map((e: OrderEdge) => e.node),
      hasNextPage: data.orders.pageInfo.hasNextPage,
      endCursor: data.orders.pageInfo.endCursor,
    };
  }

  async getOrder(id: string, accountId?: string): Promise<Order | null> {
    const gql = `query GetOrder($id: ID!) {
      order(id: $id) { ${ORDER_FIELDS} }
    }`;
    const data = await this.requireClient(accountId).query<OrderResponse>(gql, {
      id,
    });
    return data.order;
  }

  async fulfillOrder(
    orderId: string,
    accountId?: string,
  ): Promise<{ id: string; status: string }> {
    // Step 1: get open fulfillment orders for this order
    const foGql = `query FulfillmentOrders($id: ID!) {
      order(id: $id) {
        fulfillmentOrders(first: 5) {
          edges {
            node {
              id
              status
              lineItems(first: 50) {
                edges { node { id totalQuantity } }
              }
            }
          }
        }
      }
    }`;
    const foData = await this.requireClient(
      accountId,
    ).query<FulfillmentOrdersResponse>(foGql, { id: orderId });
    if (!foData.order) {
      throw new Error(`Order ${orderId} not found`);
    }

    const openFOs = foData.order.fulfillmentOrders.edges
      .map((e) => e.node)
      .filter((fo) => fo.status === "OPEN" || fo.status === "IN_PROGRESS");

    if (openFOs.length === 0) {
      throw new Error("No open fulfillment orders found for this order");
    }

    // Step 2: fulfill the first open fulfillment order
    const fulfillGql = `mutation FulfillOrder($fulfillment: FulfillmentV2Input!) {
      fulfillmentCreateV2(fulfillment: $fulfillment) {
        fulfillment { id status }
        userErrors { field message }
      }
    }`;

    const lineItems = openFOs[0].lineItems.edges.map((e) => ({
      fulfillmentOrderLineItemId: e.node.id,
      quantity: e.node.totalQuantity,
    }));

    const data = await this.requireClient(
      accountId,
    ).query<FulfillmentCreateResponse>(fulfillGql, {
      fulfillment: {
        fulfillmentOrderId: openFOs[0].id,
        lineItemsByFulfillmentOrder: [
          {
            fulfillmentOrderId: openFOs[0].id,
            fulfillmentOrderLineItems: lineItems,
          },
        ],
      },
    });

    if (data.fulfillmentCreateV2.userErrors.length > 0) {
      throw new Error(
        `Fulfillment failed: ${formatUserErrors(data.fulfillmentCreateV2.userErrors)}`,
      );
    }
    if (!data.fulfillmentCreateV2.fulfillment) {
      throw new Error("Fulfillment returned no result");
    }
    return data.fulfillmentCreateV2.fulfillment;
  }

  // -----------------------------------------------------------------------
  // Customers
  // -----------------------------------------------------------------------

  async listCustomers(
    opts: { first?: number; after?: string | null; query?: string | null } = {},
    accountId?: string,
  ): Promise<{
    customers: Customer[];
    hasNextPage: boolean;
    endCursor: string | null;
  }> {
    const first = Math.min(opts.first ?? 10, 50);
    const variables: Record<string, unknown> = { first };
    if (opts.after) variables.after = opts.after;
    if (opts.query) variables.query = opts.query;

    const gql = `query ListCustomers($first: Int!, $after: String, $query: String) {
      customers(first: $first, after: $after, query: $query) {
        edges { node { ${CUSTOMER_FIELDS} } }
        pageInfo { hasNextPage endCursor }
      }
    }`;

    const data = await this.requireClient(accountId).query<CustomersResponse>(
      gql,
      variables,
    );
    return {
      customers: data.customers.edges.map((e: CustomerEdge) => e.node),
      hasNextPage: data.customers.pageInfo.hasNextPage,
      endCursor: data.customers.pageInfo.endCursor,
    };
  }

  // -----------------------------------------------------------------------
  // Inventory
  // -----------------------------------------------------------------------

  async checkInventory(
    inventoryItemId: string,
    accountId?: string,
  ): Promise<InventoryLevel[]> {
    const gql = `query CheckInventory($id: ID!) {
      inventoryItem(id: $id) {
        id
        tracked
        inventoryLevels(first: 10) {
          edges { node { id available location { id name } } }
        }
      }
    }`;
    const data = await this.requireClient(
      accountId,
    ).query<InventoryItemResponse>(gql, { id: inventoryItemId });
    if (!data.inventoryItem) {
      throw new Error(`Inventory item ${inventoryItemId} not found`);
    }
    return data.inventoryItem.inventoryLevels.edges.map((e) => e.node);
  }

  async adjustInventory(
    opts: {
      inventoryItemId: string;
      locationId: string;
      delta: number;
      reason?: string;
    },
    accountId?: string,
  ): Promise<void> {
    const gql = `mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        inventoryAdjustmentGroup { reason }
        userErrors { field message }
      }
    }`;
    const data = await this.requireClient(
      accountId,
    ).query<InventoryAdjustResponse>(gql, {
      input: {
        reason: opts.reason ?? "correction",
        name: "available",
        changes: [
          {
            inventoryItemId: opts.inventoryItemId,
            locationId: opts.locationId,
            delta: opts.delta,
          },
        ],
      },
    });
    if (data.inventoryAdjustQuantities.userErrors.length > 0) {
      throw new Error(
        `Inventory adjust failed: ${formatUserErrors(data.inventoryAdjustQuantities.userErrors)}`,
      );
    }
  }

  async listLocations(accountId?: string): Promise<Location[]> {
    const gql = `{
      locations(first: 20) {
        edges { node { id name isActive } }
      }
    }`;
    const data =
      await this.requireClient(accountId).query<LocationsResponse>(gql);
    return data.locations.edges.map((e: LocationEdge) => e.node);
  }

  // -----------------------------------------------------------------------
  // Counts (for provider context)
  // -----------------------------------------------------------------------

  async getProductCount(accountId?: string): Promise<number> {
    const data = await this.requireClient(
      accountId,
    ).query<ProductCountResponse>(`{
      productsCount { count }
    }`);
    return data.productsCount.count;
  }

  async getOrderCount(accountId?: string): Promise<number> {
    const data = await this.requireClient(
      accountId,
    ).query<OrderCountResponse>(`{
      ordersCount { count }
    }`);
    return data.ordersCount.count;
  }
}
