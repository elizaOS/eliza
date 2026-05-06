import type { IAgentRuntime, SearchCategoryRegistration } from "@elizaos/core";

export const SHOPIFY_STORE_SEARCH_CATEGORY: SearchCategoryRegistration = {
  category: "shopify_store",
  label: "Shopify store",
  description:
    "Search products, orders, and customers in a connected Shopify store.",
  contexts: ["automation", "system"],
  filters: [
    { name: "query", label: "Query", type: "string", required: true },
    {
      name: "scope",
      label: "Scope",
      description: "Store object type to search.",
      type: "enum",
      default: "all",
      options: [
        { label: "All", value: "all" },
        { label: "Products", value: "products" },
        { label: "Orders", value: "orders" },
        { label: "Customers", value: "customers" },
      ],
    },
    {
      name: "limit",
      label: "Limit",
      description: "Maximum results to fetch per scope.",
      type: "number",
      default: 5,
    },
  ],
  resultSchemaSummary:
    "Shopify store search sections keyed by products, orders, and customers with Admin GraphQL product/order/customer records.",
  capabilities: ["products", "orders", "customers", "storefront-admin"],
  source: "plugin:shopify",
  serviceType: "shopify",
};

function hasSearchCategory(runtime: IAgentRuntime, category: string): boolean {
  try {
    runtime.getSearchCategory(category, { includeDisabled: true });
    return true;
  } catch {
    return false;
  }
}

export function registerShopifySearchCategory(runtime: IAgentRuntime): void {
  if (!hasSearchCategory(runtime, SHOPIFY_STORE_SEARCH_CATEGORY.category)) {
    runtime.registerSearchCategory(SHOPIFY_STORE_SEARCH_CATEGORY);
  }
}
