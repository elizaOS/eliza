/**
 * Configuration for connecting to a Shopify store via the Admin GraphQL API.
 */
export interface ShopifyPluginConfig {
  /** Shopify store domain, e.g. "mystore.myshopify.com" */
  storeDomain?: string;
  /** Shopify Admin API access token */
  accessToken?: string;
  /** Optional default account id for multi-account config */
  accountId?: string;
  /** Optional per-store account records keyed by account id */
  accounts?: Record<
    string,
    {
      storeDomain?: string;
      accessToken?: string;
      label?: string;
    }
  >;
}

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

export interface ShopInfo {
  name: string;
  email: string;
  myshopifyDomain: string;
  plan: { displayName: string };
  currencyCode: string;
  primaryDomain: { url: string };
}

export interface ShopInfoResponse {
  shop: ShopInfo;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export interface MoneyV2 {
  amount: string;
  currencyCode: string;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export interface ShopifyImage {
  url: string;
  altText: string | null;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export interface ProductVariant {
  id: string;
  title: string;
  price: string;
  sku: string | null;
  inventoryQuantity: number | null;
}

export interface ProductVariantEdge {
  node: ProductVariant;
}

export interface Product {
  id: string;
  title: string;
  handle: string;
  status: string;
  descriptionHtml: string;
  productType: string;
  vendor: string;
  totalInventory: number | null;
  featuredImage: ShopifyImage | null;
  variants: { edges: ProductVariantEdge[] };
}

export interface ProductEdge {
  node: Product;
}

export interface ProductsResponse {
  products: {
    edges: ProductEdge[];
    pageInfo: PageInfo;
  };
}

export interface ProductCreateResponse {
  productCreate: {
    product: Product | null;
    userErrors: ShopifyUserError[];
  };
}

export interface ProductUpdateResponse {
  productUpdate: {
    product: Product | null;
    userErrors: ShopifyUserError[];
  };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface OrderLineItem {
  title: string;
  quantity: number;
  originalUnitPriceSet: { shopMoney: MoneyV2 };
}

export interface OrderLineItemEdge {
  node: OrderLineItem;
}

export interface Order {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string;
  totalPriceSet: { shopMoney: MoneyV2 };
  customer: { id: string; displayName: string } | null;
  lineItems: { edges: OrderLineItemEdge[] };
}

export interface OrderEdge {
  node: Order;
}

export interface OrdersResponse {
  orders: {
    edges: OrderEdge[];
    pageInfo: PageInfo;
  };
}

export interface OrderResponse {
  order: Order | null;
}

export interface FulfillmentOrdersResponse {
  order: {
    fulfillmentOrders: {
      edges: Array<{
        node: {
          id: string;
          status: string;
          lineItems: {
            edges: Array<{
              node: {
                id: string;
                totalQuantity: number;
              };
            }>;
          };
        };
      }>;
    };
  } | null;
}

export interface FulfillmentCreateResponse {
  fulfillmentCreateV2: {
    fulfillment: { id: string; status: string } | null;
    userErrors: ShopifyUserError[];
  };
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export interface Customer {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  ordersCount: string;
  totalSpentV2: MoneyV2;
  createdAt: string;
}

export interface CustomerEdge {
  node: Customer;
}

export interface CustomersResponse {
  customers: {
    edges: CustomerEdge[];
    pageInfo: PageInfo;
  };
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export interface InventoryLevel {
  id: string;
  available: number | null;
  location: { id: string; name: string };
}

export interface InventoryLevelEdge {
  node: InventoryLevel;
}

export interface InventoryItemResponse {
  inventoryItem: {
    id: string;
    tracked: boolean;
    inventoryLevels: { edges: InventoryLevelEdge[] };
  } | null;
}

export interface InventoryAdjustResponse {
  inventoryAdjustQuantities: {
    inventoryAdjustmentGroup: { reason: string } | null;
    userErrors: ShopifyUserError[];
  };
}

export interface Location {
  id: string;
  name: string;
  isActive: boolean;
}

export interface LocationEdge {
  node: Location;
}

export interface LocationsResponse {
  locations: {
    edges: LocationEdge[];
  };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ShopifyUserError {
  field: string[] | null;
  message: string;
}

// ---------------------------------------------------------------------------
// Product count (via shop query)
// ---------------------------------------------------------------------------

export interface ProductCountResponse {
  productsCount: { count: number };
}

export interface OrderCountResponse {
  ordersCount: { count: number };
}
